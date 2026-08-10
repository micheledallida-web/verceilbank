# Supabase setup

Everything the app now needs on the server side, in the order to apply it. Run
the SQL in the Supabase dashboard under **SQL Editor → New query**.

Two of these are new (`activity_events`, `transactions`); the rest are settings
on tables you already have. Nothing here drops or rewrites existing data.

---

## 1. New tables

### `activity_events` — the audit log

Every screen opened, every sign-in, every setting changed, every account
opened. Written by `js/shared/activity.js`.

```sql
create table if not exists public.activity_events (
  id           bigint generated always as identity primary key,
  -- The client's own id for the row. It is what makes a retry safe: a row that
  -- was queued twice because a flush timed out after the insert landed is
  -- recognised as the same row instead of written again.
  local_id     text not null unique,
  user_id      uuid not null references auth.users (id) on delete cascade,
  event_type   text not null,
  detail       jsonb not null default '{}'::jsonb,
  occurred_at  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists activity_events_user_time_idx
  on public.activity_events (user_id, occurred_at desc);
```

### `transactions` — the ledger

The table the account screens already read and nothing was writing. Money
movements land here in addition to their own product table (`transfers`,
`payments`, `wire_transfers`, `external_transfers`, `investment_orders`).

```sql
create table if not exists public.transactions (
  id               bigint generated always as identity primary key,
  local_id         text not null unique,
  user_id          uuid not null references auth.users (id) on delete cascade,
  -- 'checking' | 'savings' | 'interest_checking' | 'investments'
  -- | 'ira_traditional' | 'ira_roth' | 'credit'
  account_type     text not null,
  -- Signed: negative leaves the account, positive arrives in it.
  amount           numeric(14,2) not null,
  title            text not null,
  date_info        text,
  icon_text        text,
  category         text,
  reference_number text,
  status           text not null default 'completed',
  created_at       timestamptz not null default now()
);

create index if not exists transactions_user_account_time_idx
  on public.transactions (user_id, account_type, created_at desc);
```

---

## 2. Row Level Security

**Apply this to both new tables.** Without it the anon key can read every
customer's ledger.

```sql
alter table public.activity_events enable row level security;
alter table public.transactions    enable row level security;

-- Read and write your own rows, and nobody else's.
create policy "own activity events read"
  on public.activity_events for select using (auth.uid() = user_id);
create policy "own activity events insert"
  on public.activity_events for insert with check (auth.uid() = user_id);

create policy "own transactions read"
  on public.transactions for select using (auth.uid() = user_id);
create policy "own transactions insert"
  on public.transactions for insert with check (auth.uid() = user_id);
```

Deliberately **no update or delete policy on either table.** An audit log a
client can edit is not an audit log, and a ledger a client can rewrite is not a
ledger. Corrections are posted as new rows, or made with the service key.

### Check the same is true of the tables you already have

Run this and confirm every row says `true`:

```sql
select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relkind = 'r'
order by relname;
```

Any table reading `false` is readable by anyone holding the anon key — which is
in the shipped JavaScript. The ones that matter most: `accounts`,
`user_profile`, `profiles`, `verification_requests`, `transfers`, `payments`,
`wire_transfers`, `external_transfers`, `investment_orders`, `card_reports`,
`notifications`.

---

## 3. Realtime

The app subscribes to its own ledger and event rows so a credit posted by a
representative, or a transfer made on another device, appears without a
refresh. Add both tables to the publication:

```sql
alter publication supabase_realtime add table public.transactions;
alter publication supabase_realtime add table public.activity_events;
```

`accounts` should already be on it — the dashboard has subscribed to it for a
while. Confirm with:

```sql
select tablename from pg_publication_tables where pubname = 'supabase_realtime';
```

---

## 4. Locking name and date of birth

Customers can no longer edit either field in the app. Enforce that on the
server too, so the rule does not depend on the UI:

```sql
create or replace function public.freeze_verified_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Once a profile is verified, the identity fields are the bank's record.
  -- A change has to come from an administrator using the service key, which
  -- bypasses RLS and does not run as an authenticated user.
  if auth.uid() is not null and coalesce(old.kyc_locked, true) then
    new.first_name    := old.first_name;
    new.middle_name   := old.middle_name;
    new.last_name     := old.last_name;
    new.suffix        := old.suffix;
    new.date_of_birth := old.date_of_birth;
  end if;
  return new;
end;
$$;

alter table public.user_profile
  add column if not exists kyc_locked boolean not null default true;

drop trigger if exists freeze_verified_identity on public.user_profile;
create trigger freeze_verified_identity
  before update on public.user_profile
  for each row execute function public.freeze_verified_identity();
```

To correct somebody's name or date of birth as an administrator, use the SQL
editor or the service key — both bypass this trigger's `auth.uid()` check:

```sql
update public.user_profile
   set first_name = 'Ada', last_name = 'Lovelace'
 where user_id = '<uuid>';
```

---

## 5. Sign-up now collects more

The sign-up flow writes these to `auth.users.raw_user_meta_data`, so no schema
change is needed to store them. If you want them on `user_profile` as well, add
the columns and copy them across at verification:

```sql
alter table public.user_profile
  add column if not exists address_line1 text,
  add column if not exists address_line2 text,
  add column if not exists city          text,
  add column if not exists state         text,
  add column if not exists postal_code   text,
  add column if not exists ssn_last4     text;
```

**Only the last four digits of the SSN ever reach the client's metadata.** The
full number is typed at sign-up and again at identity verification, where it
goes to `verification_requests`. If you want it stored encrypted rather than in
plain text, enable `pgsodium` and store it in an encrypted column — never widen
what the anon key can read.

---

## 5b. `user_profile` — why saving an address fails

If a customer edits their mailing address, phone or email and the save does not
stick, this is why. The app upserts on `user_id`, and **Postgres needs a unique
constraint on that column for an upsert to work.** Without one every profile
save fails, for every customer, with error `42P10`.

The app now falls back to update-then-insert when it sees that error, so saving
works either way — but the constraint is what makes it a single round trip and
what stops two rows ever existing for one person.

```sql
-- One profile row per customer. Deduplicate first if any user already has two.
delete from public.user_profile a
 using public.user_profile b
 where a.user_id = b.user_id
   and a.ctid > b.ctid;

alter table public.user_profile
  add constraint user_profile_user_id_key unique (user_id);
```

Then make sure every column the app writes actually exists:

```sql
alter table public.user_profile
  add column if not exists res_street       text,
  add column if not exists res_apt          text,
  add column if not exists res_city         text,
  add column if not exists res_state        text,
  add column if not exists res_zip          text,
  add column if not exists res_country      text,
  add column if not exists mail_same_as_res boolean default true,
  add column if not exists mail_street      text,
  add column if not exists mail_city        text,
  add column if not exists mail_state       text,
  add column if not exists mail_zip         text,
  add column if not exists phone_country_code text,
  add column if not exists phone_number     text,
  add column if not exists phone_verified   boolean default false,
  add column if not exists email            text,
  add column if not exists email_verified   boolean default false;
```

And that the customer is allowed to write their own row:

```sql
alter table public.user_profile enable row level security;

create policy "own profile read"
  on public.user_profile for select using (auth.uid() = user_id);
create policy "own profile insert"
  on public.user_profile for insert with check (auth.uid() = user_id);
create policy "own profile update"
  on public.user_profile for update using (auth.uid() = user_id);
```

The identity-freeze trigger in section 4 still applies on top of this — the
update policy lets a customer change their address, and the trigger stops that
same update touching their name or date of birth.

### Checking it from the SQL editor

```sql
-- Should return one row: user_profile_user_id_key
select conname from pg_constraint
 where conrelid = 'public.user_profile'::regclass and contype = 'u';

-- Should list select, insert and update
select policyname, cmd from pg_policies
 where schemaname = 'public' and tablename = 'user_profile';
```

---

## 5c. Balances — make the ledger the source of truth

**This is the most important thing left to do.**

A transfer writes a `transfers` row, writes its two `transactions` rows, and
updates the number on screen — but nothing updates `accounts.balance`. Refresh
the page and the old balance is back, because the balance column has never
moved. Every figure in the app is honest about what the server holds; the
server is just not being told.

The fix is not to have the client write balances — two devices doing arithmetic
on the same account is how money goes missing. Let the database derive the
balance from the ledger, in one trigger:

```sql
create or replace function public.apply_transaction_to_balance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A pending row is not money that has moved yet: a wire under review or an
  -- unsettled trade leaves the balance alone until its status becomes
  -- 'completed'. Only completed rows touch the balance.
  if new.status <> 'completed' then
    return new;
  end if;

  update public.accounts
     set balance = coalesce(balance, 0) + new.amount
   where user_id = new.user_id
     and account_type = new.account_type;

  return new;
end;
$$;

drop trigger if exists apply_transaction_to_balance on public.transactions;
create trigger apply_transaction_to_balance
  after insert on public.transactions
  for each row execute function public.apply_transaction_to_balance();
```

And the same when a pending row later settles:

```sql
create or replace function public.apply_settled_transaction()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status <> 'completed' and new.status = 'completed' then
    update public.accounts
       set balance = coalesce(balance, 0) + new.amount
     where user_id = new.user_id
       and account_type = new.account_type;
  end if;
  return new;
end;
$$;

drop trigger if exists apply_settled_transaction on public.transactions;
create trigger apply_settled_transaction
  after update on public.transactions
  for each row execute function public.apply_settled_transaction();
```

Once this is in, everything else already works: `accounts` is on the Realtime
publication, so the dashboard's balances move the moment a row lands — on this
device and on every other one the customer has open.

### Rebuilding a balance from scratch

Because the ledger is now the record, a balance can always be recomputed. Useful
after a correction, or to check the trigger is keeping up:

```sql
select a.user_id,
       a.account_type,
       a.balance                             as stored,
       coalesce(sum(t.amount) filter (where t.status = 'completed'), 0) as from_ledger
  from public.accounts a
  left join public.transactions t
    on t.user_id = a.user_id and t.account_type = a.account_type
 group by a.user_id, a.account_type, a.balance
having a.balance is distinct from
       coalesce(sum(t.amount) filter (where t.status = 'completed'), 0);
```

Any row this returns is an account whose stored balance and ledger disagree.

### Posting a credit by hand

A deposit that has cleared, an adjustment, a correction — insert the ledger row
and the balance follows:

```sql
insert into public.transactions
  (local_id, user_id, account_type, amount, title, category, status)
values
  (gen_random_uuid()::text, '<uuid>', 'checking', 500.00,
   'Deposit received', 'deposit', 'completed');
```

---

## 5d. The deposit rate

Fund Account now reads the bitcoin rate from `bank_settings` rather than a
figure compiled into the JavaScript, which was wrong the day after it shipped
and is the number a customer's deposit gets converted at:

```sql
alter table public.bank_settings
  add column if not exists btc_usd_rate numeric(14,2);

update public.bank_settings set btc_usd_rate = 106468.20 where id = 1;
```

Keep it current from wherever you take a price feed. If the column is absent or
the read fails, the app falls back to its built-in figure rather than leaving
the screen unable to quote anything.

The receiving address on that screen is live — a mainnet P2WPKH address in
`js/pages/fund-account.js`, checksum verified. The QR is drawn from it at
render time as a BIP-21 `bitcoin:` URI with the amount prefilled, so changing
the address changes every QR the app draws; there is no image to keep in step.

What is still outstanding there, and is not something SQL alone can fix:
nothing watches that address. A customer can send funds and the app will never
notice, because no service is reconciling incoming payments against deposit
requests. Until one exists, credit deposits by hand with the ledger insert in
section 5c — the balance follows automatically.

---

## 5e. Bitcoin deposits — the Quidax webhook

`supabase/functions/quidax-webhook/index.ts` credits a customer when a deposit
confirms at Quidax. It needs two tables.

`deposit_requests` is the link between a customer and an address: without it a
deposit is an anonymous payment and the function will not credit it to anybody.

```sql
create table if not exists public.deposit_requests (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references auth.users (id) on delete cascade,
  -- Which of their accounts the money lands in.
  account_type   text not null default 'checking',
  -- The address shown to this customer for this request.
  address        text not null,
  quidax_user_id text,
  amount_usd     numeric(14,2),
  -- The rate they were quoted. The credit uses this, not the rate at the
  -- moment the coins land, because that is the number they were shown.
  quoted_rate    numeric(14,2),
  status         text not null default 'awaiting',
  expires_at     timestamptz,
  credited_at    timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists deposit_requests_address_idx
  on public.deposit_requests (address);
create index if not exists deposit_requests_user_idx
  on public.deposit_requests (user_id, created_at desc);
```

`deposit_events` is every delivery Quidax makes, recorded before anything is
decided about it — including the ones that could not be attributed.

```sql
create table if not exists public.deposit_events (
  id                      bigint generated always as identity primary key,
  -- Quidax's own id for the deposit. Unique, so a redelivery lands on the
  -- existing row rather than crediting twice.
  reference               text not null unique,
  user_id                 uuid references auth.users (id) on delete set null,
  event_type              text,
  currency                text,
  amount                  numeric(24,8),
  address                 text,
  quidax_user_id          text,
  status                  text,
  payload                 jsonb,
  credited_transaction_id bigint,
  created_at              timestamptz not null default now()
);
```

### RLS

```sql
alter table public.deposit_requests enable row level security;
alter table public.deposit_events   enable row level security;

-- A customer may see their own deposit requests. Nothing else is granted:
-- the function writes with the service key, which bypasses RLS.
create policy "own deposit requests read"
  on public.deposit_requests for select using (auth.uid() = user_id);
```

`deposit_events` gets **no policy at all** — it holds raw exchange payloads and
belongs to the bank, not the customer.

### Secrets

In **Project Settings → Edge Functions → Secrets**:

| Name | Value |
|---|---|
| `QUIDAX_WEBHOOK_SECRET` | the Signature Secret you set in Quidax |
| `QUIDAX_CREDIT_ACCOUNT_TYPE` | optional, defaults to `checking` |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to functions
automatically. **Never put the service key or the Quidax API key in Vercel** —
those are browser-visible.

### Deploy, and the callback URL

```bash
supabase functions deploy quidax-webhook --no-verify-jwt
```

`--no-verify-jwt` matters: Quidax has no Supabase session, so the default JWT
check would reject every delivery. The signature check inside the function is
what guards it instead.

The URL to paste into Quidax's **Callback URL** field is then:

```
https://<your-project-ref>.supabase.co/functions/v1/quidax-webhook
```

Your project ref is the subdomain of your `SUPABASE_URL` — visible under
Project Settings → General.

### Attributing a deposit by hand

When the function cannot tell whose a deposit is, it stores it and credits
nobody. To assign one:

```sql
-- What is waiting
select reference, amount, currency, address, created_at
  from public.deposit_events
 where credited_transaction_id is null
 order by created_at desc;

-- Credit it: insert the ledger row, then mark the event so it is not
-- credited twice. The balance trigger from section 5c does the rest.
with posted as (
  insert into public.transactions
    (local_id, user_id, account_type, amount, title, category, reference_number, status)
  values
    ('quidax:<reference>', '<user-uuid>', 'checking', 500.00,
     'Bitcoin deposit', 'deposit', '<reference>', 'completed')
  returning id
)
update public.deposit_events
   set credited_transaction_id = (select id from posted),
       user_id = '<user-uuid>'
 where reference = '<reference>';
```

### What is still not wired

The app does not yet create a `deposit_requests` row, and every customer is
shown the same address — so until per-customer addresses are issued through
Quidax's API, **every deposit will land in the unattributed pile** and need the
SQL above. The webhook, the tables and the crediting are ready for them; the
piece that issues an address per request is the remaining work.

---

## 6. Optional but recommended

### Close accounts that were never funded

The 60-day funding deadline is currently copy and a countdown; nothing enforces
it. This does, run on a schedule with `pg_cron`:

```sql
create or replace function public.close_unfunded_accounts()
returns void language sql security definer as $$
  update public.accounts a
     set status = 'closed'
   where a.status <> 'closed'
     and a.created_at < now() - interval '60 days'
     and coalesce(a.balance, 0) < 100
     and not exists (
       select 1 from public.transactions t
        where t.user_id = a.user_id and t.amount > 0
     );
$$;

-- Runs at 03:00 UTC daily. Enable the pg_cron extension first.
select cron.schedule('close-unfunded-accounts', '0 3 * * *',
                     'select public.close_unfunded_accounts()');
```

### Trim the event log

`activity_events` grows with every screen opened. Keep a year:

```sql
select cron.schedule('trim-activity-events', '30 3 * * 0',
  $$delete from public.activity_events where occurred_at < now() - interval '1 year'$$);
```

---

## 7. Environment variables

Unchanged, but worth confirming in **Vercel → Settings → Environment
Variables**:

| Name | Value |
|---|---|
| `SUPABASE_URL` | your project URL |
| `SUPABASE_ANON_KEY` | the anon / public key |

The anon key is shipped to the browser by design — RLS is what protects the
data, which is why section 2 matters more than anything else in this document.
Never put the service key in these variables.

---

## Checklist

- [ ] `activity_events` and `transactions` created (section 1)
- [ ] RLS enabled with select/insert policies on both, no update/delete (section 2)
- [ ] Every other public table confirmed RLS-enabled (section 2)
- [ ] Both tables added to the `supabase_realtime` publication (section 3)
- [ ] Identity freeze trigger installed on `user_profile` (section 4)
- [ ] Address / SSN-last-4 columns added if you want them off metadata (section 5)
- [ ] `user_profile` unique constraint, columns and RLS policies (section 5b) — **this is what makes address, phone and email saves work**
- [ ] Balance triggers installed on `transactions` (section 5c) — **the most important one left**
- [ ] `bank_settings.btc_usd_rate` added and set (section 5d)
- [ ] `deposit_requests` / `deposit_events` tables, secrets and the deployed webhook (section 5e)
- [ ] `pg_cron` jobs scheduled, if you want the deadline enforced (section 6)
