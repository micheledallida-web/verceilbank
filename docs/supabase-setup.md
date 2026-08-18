# Supabase setup

Everything the app now needs on the server side, in the order to apply it. Run
the SQL in the Supabase dashboard under **SQL Editor → New query**.

Two of these are new (`activity_events`, `transactions`); the rest are settings
on tables you already have. Nothing here drops or rewrites existing data.

> **The short version:** paste `supabase/setup.sql` into the SQL Editor and run
> it. It is the whole of this document as one runnable, re-runnable file, and it
> prints a pass/fail table at the end. This page explains what each part does
> and why. Read section 0 first if auth is misbehaving right now.

---

## 0. Sign-up or sign-in is not working

Open the browser console on the sign-in page and try it. Every auth failure now
writes a line beginning `[auth:signin]` or `[auth:signup]` naming what actually
happened, and anything that looks like our fault also runs a probe that writes
`[auth:probe]` with a verdict. You can run that probe by hand at any time:

```js
VerceilAuth.probe()
```

What it will tell you, and what each answer means:

| Verdict | What to do |
| --- | --- |
| `js/config.js did not load` | The build did not run. `npm run build` runs `scripts/generate-config.js`, which writes `js/config.js` from the `SUPABASE_URL` / `SUPABASE_ANON_KEY` environment variables. That file is gitignored, so it exists only after a build. |
| `rejected the anon key` | The key in `js/config.js` is not this project's. Copy it again from **Project Settings → API**. |
| `Could not reach the project at all` | Wrong URL, or the project is paused. Supabase pauses free projects after a week with no traffic — the dashboard shows a **Restore** button. |
| `sign-ups are DISABLED` | **Authentication → Sign In / Providers → Allow new users to sign up.** |
| `Email confirmation is ON` | Working as designed. A new customer has no session until they open the emailed link, so sign-up shows "check your email" rather than going to the dashboard. Turn it off under the same screen if you want them signed straight in. |

Two failures worth naming separately, because neither reaches the probe:

- **"Database error saving new user."** This comes from a trigger on
  `auth.users` throwing. An error in such a trigger aborts the insert that fired
  it, so sign-up does not degrade — it stops completely, for everyone. Section 5
  of `setup.sql` replaces any older `handle_new_user` with one whose entire body
  is inside an exception handler for exactly this reason.
- **A blank or stuck button.** The `supabase-js` bundle is loaded from a CDN. If
  a content blocker eats it, `window.supabase` is never defined. The pages now
  say so instead of failing silently, and every auth call has a 20-second
  timeout so nothing waits forever.

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

### The other twenty-five tables

The two blocks above are what this document used to say, and they were not
enough. The app reads and writes **thirty** tables. Securing five of them left
the rest in whatever state they happened to be in, and there are only two
states, both bad:

- **RLS off** — the anon key, which is in every visitor's browser by design, can
  read every customer's investments, statements, support messages, linked bank
  accounts and tax documents.
- **RLS on with no policy** — the table denies everything, and the screen that
  reads it renders empty forever with no error anyone ever sees.

Section 4 of `supabase/setup.sql` now covers all of them from one table of
intent, so there is a single place to check what a customer session may do to
each table. Run this to see where you stand:

```sql
select c.relname,
       c.relrowsecurity as rls_on,
       count(p.polname)  as policies
  from pg_class c
  left join pg_policy p on p.polrelid = c.oid
 where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
 group by 1, 2
 order by 2, 3, 1;
```

`rls_on = false` is a leak. `rls_on = true, policies = 0` is a dead screen. The
only table that should show `true, 0` is `deposit_events`, which holds raw
exchange payloads and belongs to the bank.

### The balance is not a customer-writable column

The app writes one column of `accounts` — the account number it derives. An
update policy alone would therefore hand every customer the ability to set their
own balance, since RLS decides which **rows** may be written, never which
**columns**. That takes a grant:

```sql
revoke update on public.accounts from authenticated;
grant  update (account_number) on public.accounts to authenticated;
```

Balances move through the ledger triggers and nowhere else. `setup.sql` applies
this, and its verification section fails loudly if it is ever undone.

### Neither is the balance on a *new* account

The same reasoning applies to INSERT, and it is easier to miss. The insert
policy checks **whose** row is being written and says nothing about what is in
it — so a customer session could open an account for itself, which is what the
Open an Account screen legitimately does, and set the opening balance in the
same statement. Opening an account with a million dollars in it is one request.

Two columns are all a customer needs:

```sql
revoke insert on public.accounts from authenticated;
grant  insert (user_id, account_type) on public.accounts to authenticated;
```

Everything else takes its column default: `balance` 0, `status` `'pending'`,
`ownership` `'individual'`. That last one is what makes the joint-account rule
real — `ownership = 'joint'` can only be written by the bank, with the service
key, after both owners have been identified and the ownership agreement has been
countersigned.

### Never use `upsert()` against `accounts`

PostgreSQL implements an upsert as `INSERT ... ON CONFLICT DO UPDATE`, and it
checks UPDATE privilege on every column in the SET list **before** it runs —
whether or not a conflict actually occurs. With update narrowed to
`account_number`, every upsert against this table fails with *permission
denied*, and the screen that issued it reports an account it never opened.

Open accounts with a plain `INSERT` and treat SQLSTATE `23505` as success: the
unique constraint on `(user_id, account_type)` is what makes it safe to call
twice, and a duplicate refusal means the account already exists, which is the
outcome the caller wanted. `openAccountRow()` in `js/main.js` is the single
place the app does this.

---

## 3. Realtime

The app subscribes to its own ledger and event rows so a credit posted by a
representative, or a transfer made on another device, appears without a refresh.
There are **five** subscriptions, all filtered to the signed-in customer:

| Channel | Table | Events | What it drives |
| --- | --- | --- | --- |
| `activity` | `transactions` | INSERT | the ledger and activity lists |
| `activity` | `activity_events` | INSERT | the audit trail |
| `accounts` | `accounts` | `*` | every balance on screen |
| `notifications` | `notifications` | INSERT | the alerts list and the bell badge |
| `deposits` | `deposit_requests` | UPDATE | Fund Account: "awaiting" → "received" |

All five tables must be in the publication:

```sql
alter publication supabase_realtime add table public.transactions;
alter publication supabase_realtime add table public.activity_events;
alter publication supabase_realtime add table public.accounts;
alter publication supabase_realtime add table public.notifications;
alter publication supabase_realtime add table public.deposit_requests;
```

### Do not subscribe the app to `deposit_events`

It is the obvious-looking table to watch for a deposit, and it is the wrong one.
`deposit_events` holds the raw exchange payloads — every customer's deposit
address, amounts, exchange user ids, and the payments that could not be
attributed to anybody. It is the bank's table. It has RLS with no policy, so a
browser subscribing to it receives nothing at all; and adding a policy to "make
it work" would hand one customer the deposit traffic of every other.

`deposit_requests` is the same event told to the one person it concerns: their
row, their amount, their status. That is what the Fund Account screen watches.

`notifications` is the one that was missing. **The app has subscribed to it all
along and it was never published, so the bell has never once lit up on its
own.** That is worth understanding because of how this fails:

> A table that is not in the publication produces a channel that **joins
> successfully and then never delivers anything.** No error, no warning, nothing
> on the console. The screen simply never updates — which is indistinguishable
> from an account where nothing has happened.

### `accounts` also needs `replica identity full`

```sql
alter table public.accounts replica identity full;
```

By default Postgres writes only the primary key of the old row to the WAL.
Realtime applies RLS to a DELETE by testing the **old** record — and a record
consisting of nothing but an `id` has no `user_id` to test, so the policy cannot
pass and the event is silently dropped. `accounts` is the only subscription
listening for `*`; the others are INSERT-only, where the new row is complete.

### Checking it

From the SQL editor:

```sql
select tablename from pg_publication_tables where pubname = 'supabase_realtime';
```

From the browser console, on the dashboard:

```js
VerceilRealtime.status()
// { activity: 'SUBSCRIBED', accounts: 'SUBSCRIBED' }
```

`activity` and `accounts` are always there. `notifications` and `deposits`
appear only while their screens are open, since those channels are opened and
torn down with the view.

Every channel should read `SUBSCRIBED`. Anything else was already written to the
console under `[realtime]` with the reason — the subscriptions now report their
status instead of failing silently, and a channel that errors is rebuilt with a
backoff rather than staying dead for the rest of the session.

Realtime also has a project-level switch: **Database → Replication**, or
**Settings → API → Realtime**. If every channel errors and the publication is
correct, check there.

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

## 5a. Sign-up has to produce something

Sign-up collects a name, a date of birth, the last four of an SSN, an address
and a chosen product, and hands the lot to Supabase as user metadata. Until now
that is where it stopped: the details landed in
`auth.users.raw_user_meta_data` and nothing in `public` ever read them. A brand
new customer signed in to a dashboard with no profile row, no accounts and no
record of what they had asked to open — so the app looked like it had lost the
application.

Section 5 of `setup.sql` adds a trigger on `auth.users` that unpacks the
metadata the moment the auth user is created: it writes `user_profile`, seeds
`profiles.kyc_status`, and opens the requested accounts at `status = 'pending'`
with a zero balance — plus savings, which comes with every product, enforced
here rather than trusted from the browser. Nothing is `approved` until identity
is verified and the opening deposit lands.

It also backfills. Anyone who signed up before the trigger existed has their
details sitting on their auth user and not all of them in `public`; the backfill
runs the same function over them. Every insert is `on conflict do nothing`, so
an existing customer's profile, balances and accounts are never touched.

### The backfill condition, and why it matters more than it looks

The backfill considers a customer with **no `user_profile` row OR no `accounts`
row**. That second clause is not belt and braces — it is the whole fix for a
fault that reads as an account having stopped working.

An earlier version of this app wrote a profile row at sign-up and opened no
accounts. A backfill that only looked for a missing profile skipped exactly
those customers, every time it ran. And `accounts` is where a balance lives:
the ledger triggers in section 4 move money with

```sql
update public.accounts set balance = ... where user_id = ... and account_type = ...
```

With no row to match, **every deposit and every transfer updates nothing**. The
money is in the ledger, the balance never changes, and there is no error
anywhere — the account looks broken and nobody can say why. Because the trigger
existed by the time later sign-ups happened, the fault presents as *"my first
accounts don't work and only my newest one does"*.

The last statement of section 5 now names anyone still holding no accounts, as
a warning, so this can never again be discovered by the customer it belongs to.
`js/main.js` also repairs it client-side — a signed-in customer with zero rows
gets the product they asked for at sign-up, plus savings — so a browser open
right now recovers whether or not this file has been re-run.

### Reopening the account is only half the repair

The balance triggers fire on a ledger row **as it is written**. They do not
replay history. So a customer who banked for weeks with no `accounts` row has
every deposit sitting in `transactions` and an account that has just come back
reading zero. Their money was never lost — it is in the ledger, which is the
record that matters — but nothing had told the balance about it.

Section 5 therefore rebuilds the cache from the ledger, using `status =
'completed'`, the same test the trigger applies, so a pending trade is left out
of both. The condition is deliberately narrow: **only an account sitting at
exactly zero whose ledger says otherwise.** That can only be an account which
missed its own history.

Any other disagreement is a different fault and is left alone. A
representative's manual correction, posted with the service key, is a real
adjustment, and rewriting it from the ledger would silently undo it — so
section 10 reports those and a person decides. Only `js/main.js` and the
triggers touch a balance otherwise; customers never can.

Check for anyone who slipped through:

```sql
select u.id, u.email, u.created_at
  from auth.users u
  left join public.user_profile p on p.user_id = u.id
 where p.user_id is null;
```

An empty result is correct. Rows here mean the trigger warned rather than
wrote — look for `provision_user failed` in **Logs → Postgres**.

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

The receiving address on that screen is live — a mainnet P2PKH address in
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

## 5f. Statement downloads — where the file comes from

**Download PDF now downloads a PDF.** It used to open a second window with an
HTML summary in it and leave the customer to find *Print → Save as PDF* — which
on a phone is not a download at all, and on iOS is a window Safari often refuses
to open in the first place.

There are two paths behind that one button, and the app picks between them per
row:

1. **The bank's own file.** If the statement row carries a
   `storage_object_path`, the app asks Storage for a signed URL for that object
   — this customer, ten minutes, `download` set so it arrives as a file rather
   than opening in a tab — and downloads it.
2. **A generated summary.** If the row has no path (or the object behind it
   cannot be reached), the app renders the row into a real one-page PDF in the
   browser and saves that. No library, no CDN — see `js/shared/documents.js`.

Path 2 means the button works today, on every row already in the table, with
nothing set up. Path 1 is what turns each row into the real document, and it
needs section 11 of `setup.sql`: the private `statements` bucket, its read
policy, and the pointer columns on `investment_statements` and
`account_documents`.

### Generating the files

Whatever produces the PDFs — a scheduled job, an edge function, a back-office
tool — writes with the **service key**, never from a browser. The bucket has a
read policy and nothing else, deliberately: a customer session that could write
here could write its own statement.

Two rules, both of them load-bearing:

**The path starts with the owner's user id.**

```
statements/<user-id>/<period>-<doc-type>.pdf
```

The read policy checks `(storage.foldername(name))[1] = auth.uid()`, so a file
stored under any other shape is one its owner cannot read.

**Regenerating a period updates the row, it does not add one.** Upload the
object, then upsert on user + `statement_period` + `doc_type`:

```sql
insert into public.investment_statements
       (user_id, period_type, doc_type, statement_period,
        storage_object_path, file_name, mime_type, file_size_bytes, file_generated_at)
values (:user_id, :period_type, :doc_type, :statement_period,
        :path, :file_name, 'application/pdf', :bytes, now())
on conflict (user_id, statement_period, doc_type) do update
   set storage_object_path = excluded.storage_object_path,
       file_name           = excluded.file_name,
       mime_type           = excluded.mime_type,
       file_size_bytes     = excluded.file_size_bytes,
       file_generated_at   = excluded.file_generated_at;
```

The unique constraint that makes that an upsert is added by section 11 — but
only if the table does not already hold duplicate period/type rows. If it does,
the script warns and leaves the constraint off rather than failing; dedupe those
rows and re-run it.

Nothing else changes in the app when a path appears in a row. The next download
is the real file.

---

## 5h. External accounts — linking one, and being allowed to send to it

**`public.external_accounts` was never created by anything.** Three screens read
and write it — Link Account, Linked Accounts, External Transfers — and the RLS
pass skipped it every run:

```
NOTICE: RLS: skipping external_accounts, table not present
```

So on a project that never made the table by hand, "Add External Bank" failed on
the insert and said *"Could not save this account right now"*, which is true and
tells nobody anything. Section 12 of `setup.sql` creates it.

### Linking is instant. Sending is held for 30 days.

Anybody may link an account — the details are theirs, the row is written, it
appears in their list immediately. Sending money to it is held, because the
shape of an account takeover is: get into somebody's online banking, add an
account you control, empty the balance into it, leave. The hold turns that from
minutes into something the real customer gets a chance to notice.

Thirty days, **and then a person.** The wait alone is not enough — an attacker
patient enough to wait a month still wins if the link then activates itself — so
activation is done by customer care, who can confirm the request with the
customer whose money it is.

### Which is why `status` is not a customer-writable column

If it were, the hold would be a thirty-day inconvenience for an attacker and no
protection at all: the same stolen session that added the account could mark it
active. RLS decides which **rows** a session may write, never which **columns**,
so the column list is taken away separately — the same shape as
`accounts.balance`:

```sql
revoke insert, update on public.external_accounts from authenticated, anon;
grant insert (user_id, bank_name, routing_number, account_number,
              account_type, link_method)
  on public.external_accounts to authenticated;
```

Note the `insert` half, which is the one that is easy to miss: a column default
only applies when the column is **absent** from the INSERT, so without this a
session could simply supply `status: 'active'` and link an account it could send
to that afternoon.

### Activating one, after the phone call

```sql
update public.external_accounts
   set status = 'active', activated_at = now()
 where id = :id;
```

Run with the service key or from the SQL editor. To see what is waiting:

```sql
select id, user_id, bank_name, right(account_number, 4) as last4,
       status, created_at::date as linked_on,
       (created_at + interval '30 days')::date as eligible_from
  from public.external_accounts
 where status = 'pending'
 order by created_at;
```

### What the customer sees

The app never shows a linked account as "Verified" any more — it showed that on
every row regardless, including one added thirty seconds earlier that could not
be sent to. The badge now reads its actual standing: **Pending**, **Activation
required** once thirty days have passed, or **Active**.

The refusal itself lands at the moment a transfer is attempted, not when the
account is added, and says what to do rather than stating a policy:

- **inside 30 days** — *"Transfers to a newly linked account become available 30
  days after it is added — for this account, on September 11, 2026 (in 30 days).
  From that date, call customer care on (800) 555-0123 to activate it."*
- **past 30 days, still pending** — *"This account has not been activated yet.
  Call Verceil Bank customer care on (800) 555-0123 and we will activate it once
  we have confirmed the request with you."*

Both come from `readExternalAccountStanding()` in `js/shared/account-products.js`,
so the transfer screen and the linked-accounts list cannot disagree about the
same account.

---

## 5i. Support messages — the tables, and the mail to your inbox

A message sent from the Support screen came back with:

> Could not find the table `public.support_threads` in the schema cache

Which was true. Everything else on that path was already built — the screen
writes the thread and the first message, `support-notify` emails your inbox,
`support-inbound` turns your reply to that email back into a message in the
customer's app, and section 2 grants a customer rights over both tables. The
two tables themselves were never created. The RLS block skips a table that is
not there with a notice, so nothing complained until somebody pressed Send.

### 0. What is already there

Before working through the steps below, ask the setup what it has. Two checks,
because no single vantage point can see the whole path — the database cannot
see an edge function's secrets, and an HTTP check cannot see RLS.

```bash
npm run check:support              # tables, functions, which secrets are set
npm run check:support -- --verify  # also logs in to the mailbox, sends nothing
npm run check:support -- --test    # also sends one real email (service role key)
```

```
  ✓ table support_threads     exists, API can see it
  ✓ function support-notify   deployed
  ✗ mailbox secrets           not set: SMTP_PASSWORD — supabase secrets set SMTP_USER=… SMTP_PASSWORD=…
  – replies by email          off. Correct on Namecheap: a mailbox cannot post arriving mail to a webhook
```

It reads `SUPABASE_URL` and `SUPABASE_ANON_KEY` from the environment, or from
`js/config.js` once `npm run build` has generated it. `--test` additionally
needs `SUPABASE_SERVICE_ROLE_KEY`, because the function gates a real send on it.

Then paste **`supabase/check-support-mail.sql`** into the SQL editor for the
database half: both tables, RLS on each, how many policies are attached, the
trigger that moves a thread to `answered`, and what traffic has actually gone
through — including how many threads are sitting unanswered, which is the
closest thing the database has to "the mail is not arriving". It creates
nothing and changes nothing.

Four marks, and the fourth matters: `✓` present, `✗` missing, `–` not
applicable (never a fault), `?` **could not be checked**. A `?` means nothing
answered — a wrong URL, a rejected key, a proxy in the way — and is not a pass.
A check that cannot reach the project says so rather than guessing.

### 1. Create them

`supabase/setup.sql` now creates them, so re-run that file — it is written to
be run repeatedly. To do just this part, run the `support_threads` and
`support_messages` blocks from section 1 of that file, then re-run section 4 so
the policies attach to them.

Confirm:

```sql
select table_name from information_schema.tables
 where table_schema = 'public' and table_name like 'support%';
-- -> support_messages, support_threads

select relname, relrowsecurity from pg_class
 where relname in ('support_threads', 'support_messages');
-- -> both true
```

Without RLS on, the anon key in every visitor's browser can read every
customer's messages to their bank. Do not skip the second query.

If the app still says the table is missing after you have created it, it is the
API's schema cache, not the database. PostgREST answers from its own picture of
the schema and a table created a moment ago is not in it yet. Running
`setup.sql` ends by asking for a reload; on its own:

```sql
notify pgrst, 'reload schema';
```

### What the reference on the error means

The Support screen shows a plain sentence with a short code on the end. The
code is the fault, and it says which of these to fix:

| Ref | Meaning |
| --- | --- |
| `PGRST205` | the table is not in the API's schema cache — create it, or reload the cache as above |
| `42P01` | the table really is not there — run step 1 |
| `42501` | row level security refused the row — section 4 has not run against these tables |
| `23503` | the thread the message belongs to does not exist |

No code on the end means the request never reached the database: the browser
was offline, or the project URL and anon key are wrong.

### 2. Point the mail at your inbox

Messages go to **support@verceilbank.com**, from
`Verceil Bank <support@verceilbank.com>`. Both are the function's defaults, so
there is one thing to set:

The mail goes out through the `support@verceilbank.com` mailbox on **Namecheap
Private Email**, over SMTP. There is no API key, because a mailbox provider has
no send API — the function logs in as the mailbox and hands the message over
the way a mail client would.

```bash
supabase functions deploy support-notify
supabase secrets set \
  SMTP_USER=support@verceilbank.com \
  SMTP_PASSWORD='your-mailbox-password'
```

| Secret | | |
| --- | --- | --- |
| `SMTP_USER` | required | the full mailbox address. Namecheap wants the whole address, not a username |
| `SMTP_PASSWORD` | required | the mailbox password from the Private Email dashboard — there is no separate app password. Server-side only: this password can *read* support@ as well as send from it, which is the entire reason this runs as a function |
| `SUPPORT_INBOX` | optional | overrides where the message lands. Defaults to `support@verceilbank.com` |
| `SUPPORT_FROM` | optional | overrides the sender. Defaults to `Verceil Bank <SMTP_USER>`. It cannot change *who* the mail is from — the provider refuses a From that is not the mailbox that logged in |
| `SMTP_HOST` | optional | defaults to `mail.privateemail.com` |
| `SMTP_PORT` | optional | defaults to `465`. **Leave it there** — see below |

Only the two secrets have to be set. Where the mail goes is not a secret — it
is in the site footer, in the page's structured data and on the Support screen
— and it is a default rather than a variable because a list of required
settings meant the path could be deployed, correct, and silently mailing
nowhere for want of one of them.

**Port 465, not 587.** Namecheap documents both, but Supabase's edge runtime
does not allow outbound connections on port 25 and is unreliable on 587, so 465
with implicit TLS is the one that actually connects. A send that hangs and then
times out with nothing in the logs is this.

With a required setting unset the function answers "Email is not configured"
and names the missing ones in the response. The customer still sees their
message saved and the thread open, because the app never waits on the mail — a
mail outage must not look to somebody like a failed send.

Ask it about itself rather than sending a message to find out:

```bash
curl "$SUPABASE_URL/functions/v1/support-notify" -H "Authorization: Bearer $SUPABASE_ANON_KEY"
# {"function":"support-notify","deployed":true,"configured":true,"missing":[],
#  "transport":"smtp://mail.privateemail.com:465","inbound_replies_enabled":false}
```

`404` means the function was never deployed — do the deploy above. A reply with
`"configured": false` lists the settings still to set. It reports only whether
each one is present, never its value.

Add `?verify=1` and it logs in to the mailbox without sending anything, which
is the only way to tell a wrong password apart from a message that was accepted
and then went missing:

```bash
curl "$SUPABASE_URL/functions/v1/support-notify?verify=1" -H "Authorization: Bearer $SUPABASE_ANON_KEY"
# {"smtp_login":"failed","smtp_code":535,"smtp_message":"535 Incorrect authentication data"}
```

Once that says `ok`, send a real one. This posts an actual email to
`SUPPORT_INBOX`, which is the only thing that proves delivery rather than
login:

```bash
curl "$SUPABASE_URL/functions/v1/support-notify?test=1" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
# {"smtp_login":"ok","test_send":"accepted","test_send_to":"you@yourbusiness.com"}
```

It takes the **service role key**, not the anon key, and it always sends to
`SUPPORT_INBOX` — the destination comes from config and can never be passed in.
Anything less would leave a URL that makes the mailbox send on demand for
anyone who finds it.

Neither project key works on `POST`, and this catches people out: the anon key
and the **service role key** both come back `401`. Service role bypasses RLS,
but this path is not gated on RLS — it asks which customer is sending, and a
project key is not a customer. It needs the access token of a signed-in user.
The `401` now says which key it was given rather than a flat "not signed in".

Note that `POST` cannot be used as a mail test, whatever payload you give it.
It takes `thread_id` and `message_id` for rows that already exist and reads the
message out of the database, and it wants the access token of the customer who
owns the thread — an anon key is not a signed-in user, so it is turned away
with `401` before any mail is attempted. That is correct for the send path and
useless for "does mail work at all", which is what `?verify=1` and `?test=1`
are for.

When a send fails, the response carries what the mail server said:

```json
{ "error": "Could not send the notification email",
  "smtp_code": 535,
  "smtp_message": "535 Incorrect authentication data" }
```

The usual ones:

| | |
| --- | --- |
| `535` | wrong mailbox password, or `SMTP_USER` is not the full address |
| `550` / `553` | the From is not the mailbox that logged in — unset `SUPPORT_FROM`, or point it at the same address |
| a timeout, no code | the port. See above: use 465 |

### 1b. Deploying without a terminal

A project came back `404 NOT_FOUND` from this function after a morning of
customers using the Support screen: the tables were there, the secrets were
there, and the function had simply never been deployed. Nothing complained,
because the app never waits on the mail — the messages were saved and read
back perfectly while every notification went to a function that did not exist.

Ask before assuming it is there:

```sql
select net.http_get(
  url := '<project-url>/functions/v1/support-notify',
  headers := '{"Authorization": "Bearer <anon key>"}'::jsonb) ;
-- then, a few seconds later:
select status_code, content from net._http_response order by created desc limit 1;
```

(`create extension if not exists pg_net;` first, if `net` does not exist.)

`404` means deploy it. With the CLI that is `supabase functions deploy
support-notify`. From the dashboard — **Edge Functions → Deploy a new function
→ via editor** — the editor deploys the files of one folder and cannot follow
`../_shared/mailer.ts`, so give it a flattened copy:

```bash
node scripts/bundle-function.js support-notify
# -> dist-functions/support-notify.ts, paste that
```

The bundle inlines the shared mailer and leaves the `npm:` and `https://`
imports for Deno to resolve at deploy time. It is a build artifact, gitignored:
generate it, paste it, discard it. Editing it instead of the source is how the
two drift apart.

### 2a. Sending messages that are already in the database

A message is saved whether or not the mail goes out — the app never waits on
the send, because a mail outage must not look to a customer like a failed send.
The cost of that choice is that a spell of broken or unconfigured mail leaves
real requests sitting in the database that nobody has read.

`?resend=1` collects them. It reads each thread's first message and mails it to
`SUPPORT_INBOX`, addressed exactly as the original would have been — same
subject tag, same `Reply-To` — because both paths build the mail with the same
function.

```bash
curl "$SUPABASE_URL/functions/v1/support-notify?resend=1" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
# {"resend":true,"to":"support@verceilbank.com","threads_considered":8,"sent":5,
#  "results":[{"thread":"9daa102d-…","skipped":"no messages on this thread"}, …]}
```

| | |
| --- | --- |
| `?thread=<id>` | just that one |
| `?limit=<n>` | how many threads to consider, oldest first. Default 25, hard cap 100 |

It takes the **service role key**, and it only ever sends to `SUPPORT_INBOX` —
the destination comes from config and can never be passed in. Both halves
matter for the same reasons they matter on `?test=1`: without the first, anyone
who found the URL could make the mailbox send on demand; without the second,
this would be an open relay with a database of real customers behind it.

A thread with no messages is skipped and said so. The app writes the thread
before its first message, so an empty one is a send that failed rather than a
request somebody made — there is nothing in it to forward.

This does not mail the customer. Nothing in this project does: `support-notify`
mails *into* the support inbox, and a reply written onto a thread is seen when
that customer next opens the app. If somebody has been waiting hours, write to
them from the mailbox by hand as well.

### 2b. "Could not send your message" with code 42501

`42501` is Postgres `insufficient_privilege` — RLS refused the write. The mail
setup is not involved; the message never reaches the database, so the function
is never called and its logs stay empty.

Two causes, and the second catches people who write the schema by hand.

**The trigger has to bypass RLS.** `touch_support_thread()` fires after a
message is inserted and updates the parent thread's `updated_at` and `status`.
It is declared `security definer` for that reason. Written without it, the
update runs as the customer, RLS judges it, and a refusal aborts the insert
that fired it — so the error is reported against the message the customer just
tried to send.

```sql
select proname, prosecdef as is_security_definer
  from pg_proc where proname = 'touch_support_thread';
-- is_security_definer must be true
```

**The insert policy has to be about the row's own `user_id`.** Both tables
carry one, and both policies are written against it. Routing ownership through
a separate participants table deadlocks thread creation: at the moment the
thread row is inserted there is no participant row yet to authorise it.

```sql
select tablename, policyname, cmd, permissive, with_check
  from pg_policies
 where tablename in ('support_threads','support_messages')
 order by tablename, cmd;
```

Policies are permissive and OR'd, so adding the correct ones is enough — an
existing wrong policy cannot block a right one, unless it was written
`restrictive`, which the `permissive` column will show. Re-running
`supabase/setup.sql` creates the correct set.

---

### 2c. Reading and answering threads from the dashboard

Until the mail is deployed — and afterwards too, since the email is a copy and
the app is the record — every conversation is readable in **SQL Editor**.

Every thread, newest first, with who sent what:

```sql
select t.id as thread, t.subject, t.status, u.email,
       m.sender, m.body, m.created_at
  from public.support_threads t
  join auth.users u            on u.id = t.user_id
  join public.support_messages m on m.thread_id = t.id
 order by t.updated_at desc, m.created_at;
```

To answer, write a message onto the thread as `support`. The `user_id` must
stay the **customer's**, because that is what RLS reads to decide who may see
the row — selecting it from the thread rather than typing it is what keeps that
right:

```sql
insert into public.support_messages (thread_id, user_id, sender, body)
select t.id, t.user_id, 'support', 'Here are the Zelle details: ...'
  from public.support_threads t
 where t.id = '<thread id from the query above>';
```

Quote the id. Depending on how the tables were created it is either a `bigint`
or a `uuid`, and a quoted literal is read correctly as either — nothing in the
app or the function cares which, since both only ever pass the id back where it
came from.

Nothing else is needed. The `touch_support_thread` trigger moves the thread to
**answered**, which is what puts the unread dot on it, and the customer sees
the reply the next time the screen loads.

To close a finished thread, `update public.support_threads set status =
'closed' where id = '<thread id>';` — the composer disappears on a closed
thread.

---

### 3. Replying by email — Resend for inbound, Namecheap for outbound

Sending and receiving are separate capabilities and Namecheap Private Email
only does the first: a mailbox has no way to hand an arriving message to a URL.
Turning a reply into a message in the customer's app needs a provider that
posts inbound mail to a webhook, so the two halves are split — Namecheap keeps
sending, because that already works and its From is the bank's own address, and
Resend receives.

Nothing needs to move for that. The outbound mail simply gains a `Reply-To` at
the receiving domain, with the thread id as a plus tag.

**The status constraint first.** `support-inbound` sets a thread to `answered`,
so a schema that does not allow that value accepts the email and then refuses
it at the last step:

```sql
select pg_get_constraintdef(oid) from pg_constraint
 where conrelid = 'public.support_threads'::regclass and conname like '%status%';
-- must include 'answered'; section 5i above has the migration if it does not
```

**Deploy it with JWT verification off.** Resend has no Supabase session, so with
verification on the gateway answers 401 before the function runs. What guards
the endpoint instead is a secret in its URL — anything that can post here can
write messages a customer reads as coming from their bank.

```bash
supabase functions deploy support-inbound --no-verify-jwt
supabase secrets set \
  SUPPORT_INBOUND_ADDRESS=support@<your-domain> \
  SUPPORT_INBOUND_SECRET=$(openssl rand -hex 24)
```

From the dashboard: deploy via the editor, then turn off **Enforce JWT
verification** on the function's settings page.

Then point the provider's inbound route at the function, secret included:

```
https://<project>.supabase.co/functions/v1/support-inbound?token=<the secret>
```

**Use a subdomain if you verify your own domain.** Inbound needs MX records
pointed at the receiving provider, and the root domain's MX are what deliver to
the Namecheap mailbox. Repointing those kills the mailbox that sends. A
subdomain — `reply.example.com` — gets its own MX and leaves it alone. A
provider's own onboarding domain avoids the question entirely.

With `SUPPORT_INBOUND_ADDRESS` set, `support-notify` puts
`Reply-To: support+<thread-id>@<domain>` on every notification and its footer
changes from "answer from the dashboard" to "reply to this email". Nothing is
asked of whoever answers: they hit reply, and the plus tag says which
conversation it belongs to. If a client strips it, the `[VB-<id>]` subject tag
is the fallback.

Left unset, none of this happens and the mail says to answer from the
dashboard, which is the honest state rather than a missing step.

### 4. Check it end to end

Send a message from the app. You should get all three:

- the thread appears on the Support screen with an **Open** pill
- a row in `support_threads` and one in `support_messages`
- the mail in your inbox, subject `[VB-<thread id>] <subject>`

If the first two happen and the mail does not, it is the secrets, not the
tables: `supabase functions logs support-notify` says which.

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

### Auth redirect URLs — required for password reset

**Authentication → URL Configuration**

| Setting | Value |
|---|---|
| Site URL | your deployed origin, e.g. `https://verceilbank.vercel.app` |
| Redirect URLs | add `https://<your-domain>/reset-password.html` |

Supabase will not send a customer to a redirect it has not been told about. If
`reset-password.html` is not on that list the reset email still arrives, but the
link drops them on the Site URL with no recovery token and the page reports that
the link cannot be used — which reads as a broken link rather than a missing
setting. Add every origin you use, preview deployments included.

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
- [ ] `support_threads` and `support_messages` created, RLS on both (section 5i)
- [ ] `support-notify` deployed with `SMTP_USER`/`SMTP_PASSWORD` for the Namecheap mailbox — confirmed with `?test=1` landing a mail in support@ (section 5i)
- [ ] Address / SSN-last-4 columns added if you want them off metadata (section 5)
- [ ] `user_profile` unique constraint, columns and RLS policies (section 5b) — **this is what makes address, phone and email saves work**
- [ ] Balance triggers installed on `transactions` (section 5c) — **the most important one left**
- [ ] `bank_settings.btc_usd_rate` added and set (section 5d)
- [ ] `deposit_requests` / `deposit_events` tables, secrets and the deployed webhook (section 5e)
- [ ] `statements` bucket (private), its read policy and the storage columns (section 5f) — only needed to serve the bank's own PDFs; downloads already work without it
- [ ] `external_accounts` table with the narrowed insert grant (section 5h) — **without it, linking a bank silently fails; without the grant, the 30-day hold is decoration**
- [ ] `pg_cron` jobs scheduled, if you want the deadline enforced (section 6)
