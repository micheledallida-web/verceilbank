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

## 5g. Offer codes — sign-up is invite-only

**Nobody opens an account without a seven-digit offer code.** The form asks for
one as its second step, before the applicant's name — deliberately, because it
is the only step that can end the application, and asking somebody for their
date of birth, four digits of their SSN and their home address before telling
them they cannot open an account is collecting a stranger's identity for
nothing.

### Where the rule actually lives

Not in the form. `auth.signUp` is a public endpoint that anybody can POST to
with the anon key, and the field on the page is editable by whoever is looking
at it. The gate is a **`BEFORE INSERT` trigger on `auth.users`**
(`on_auth_user_offer_code`, section 12 of `setup.sql`), and the ordering is the
whole design:

- The trigger raises → the insert never happens → no auth user, no profile, no
  accounts, and the code is **not** spent.
- The trigger passes → the increment and the user row commit **together**. If
  anything later in that transaction fails, both roll back.

That is why the code is consumed from a trigger rather than called from the
client before sign-up: the client-side order burns a code every time a sign-up
fails after the check, and leaves the decision with the browser.

**What a code looks like is defined once**, by the `offer_codes_seven_digits`
constraint. The trigger checks only that a code was *sent* — it does not repeat
the pattern, because a string that is not a valid code cannot be stored as one,
so it cannot match a row, so it is refused anyway and for the true reason. If
you ever move to eight digits, change the constraint and nothing else. (The
form's `OFFER_CODE_LENGTH` is a separate copy by necessity — the browser cannot
read a check constraint — but it is one constant, and the field's `maxlength`
and placeholder are written from it.)

### Issue a code

`setup.sql` creates no codes, on purpose — a code committed to a source file is
a code everybody has. Issue your own:

```sql
-- 500 accounts, seven days each from the day the invitation is emailed
insert into public.offer_codes (code, label, max_uses)
values ('4820917', 'launch-2026', 500);

-- one-shot, dead at the end of the month whenever it was sent
insert into public.offer_codes (code, label, max_uses, expires_at)
values ('3051764', 'branch-referral', 1, '2026-09-01T00:00:00Z');
```

`max_uses` null means unlimited. `active = false` switches a code off without
deleting it, which keeps the redemption history attached to something.

### When a code runs out

The clock starts when the invitation is **emailed**, not when the row is
written — codes get minted in batches and sent later, and a batch cut in
January and posted in February should not arrive already dead. So whatever
sends the invitation has to say so, immediately after the send succeeds:

```sql
select public.mark_offer_code_sent('4820917');   -- returns the deadline now in force
```

It is service-key only, and the returned timestamp is what to put in the email —
computing the date separately just gives you something to disagree with.

| `expires_at` | `sent_at` | Dies |
| --- | --- | --- |
| set | either | at `expires_at`, whenever it was sent |
| null | set | seven days after `sent_at` |
| null | null | never — **the clock has not started** |

That last row is the point of having two timestamps, and it is worth being
deliberate about: a code nothing ever marks as sent never expires. That is safe
only while an unsent code is one nobody has been given. **If nothing in your
stack calls `mark_offer_code_sent`, no code ever expires** — the column stays
null and every window stays open.

A resend does not extend the deadline (`sent_at` is only ever set once), or
"resend my code" would be an unlimited extension. To genuinely restart one,
clear `sent_at` and mark it sent again.

The seven days is stated in exactly one place, `public.offer_code_expiry`, and
every check goes through it. Change it there and the pre-check, the gate and
the "how many are usable" count all move together.

If the requirement is on and there are no usable codes, **nobody can sign up** —
so the script says so loudly when you run it:

```
WARNING: OFFER CODES: the requirement is ON and there are no usable codes — NOBODY CAN SIGN UP.
```

### Watching them

```sql
-- how much of each code is left, and when it dies
select code, label, used_count, max_uses, active,
       sent_at, expires_at,
       public.offer_code_expiry(expires_at, sent_at) as dies_at
  from public.offer_codes order by created_at desc;

-- issued but never emailed: not on the clock, and nobody can use them
select code, label from public.offer_codes where sent_at is null;

-- who came in on what, most recent first
select r.code, r.redeemed_at, u.email
  from public.offer_code_redemptions r
  join auth.users u on u.id = r.user_id
 order by r.redeemed_at desc limit 50;
```

Both tables are RLS-on with **no policy at all** — a deliberate deny-all. Read
them with the service key or from the SQL editor. A customer session cannot list
codes, count them, or see who redeemed what.

### What a stranger is allowed to ask

Exactly one thing: `offer_code_status('1234567')`, a security-definer function
granted to `anon`, which answers **`'ok'` or `'invalid'` and nothing else**.

It will not say *which kind* of invalid, and that is not laziness. A code is
seven digits, so the space is ten million; a function that distinguished "no
such code" from "that code is used up" would confirm which of those ten million
are real, one guess at a time. One word costs an applicant a slightly vaguer
message and costs an enumerator everything.

The form calls it as the offer step is cleared, so an applicant is told at the
step instead of at the end. It is a courtesy, not the rule — and a failure to
reach it is **not** treated as a bad code: the applicant goes through and the
trigger decides, because refusing somebody because their train went into a
tunnel would be the form inventing a rejection the bank never made.

### If you already had an `offer_codes` table

The script adapts one in place rather than expecting a clean slate — it does not
rename your columns out from under whatever else reads them. Instead it works
out what your table calls things and generates `offer_code_status`,
`consume_offer_code` and `offer_codes_usable` against those names. It reports
what it bound to:

```
NOTICE:  OFFER CODES bound to: code column = code_7_digit, active column = is_active
```

**The code column.** `code_7_digit` if your table has one, otherwise `code`. A
table with both is the giveaway — `code` there is a campaign slug or an internal
reference, and the seven digits are in the other one. Bind to the wrong one and
the gate matches nothing, which is at least fail-closed and obvious on the first
test.

**The active column.** `is_active` or `active`, whichever exists. This one is
not safe to get wrong in the other direction: blindly adding an `active` column
to a table that already has `is_active` leaves two flags, the new one defaulting
to true, and **every code you had switched off goes on working** — because the
switch being read is not the switch being set. Nothing adds a flag without
looking for one first.

It also fixes three things a hand-rolled version usually has:

- **`code` stored as a number.** It is the obvious choice and it is wrong: a
  seven-digit code is not a quantity, it is a string made of digits. As an
  integer, `0123456` **is** `123456` — the leading zero is not hidden, it is
  gone, and roughly one code in ten becomes a six-digit code that will never
  match what its owner types. Converted to `text` with a plain cast, which
  changes no value. Anything left shorter than seven digits already lost its
  zeros before you ran this; the format constraint refuses to be added and says
  so, because only whoever issued those codes knows what they were.
- **The code not unique.** Everything keys on it, and a campaign-plus-code model
  lets the same seven digits exist twice, in which case spending one spends
  both.
- **`used_count` null.** A tally that is NULL is not a code with no limit, it is
  a code that has never been counted — which is zero. Left alone it reads as
  unusable for ever, because `null < max_uses` matches no row. Backfilled to 0,
  given a default, and coalesced in every predicate.

A NULL in the active column is read as **off**, everywhere, deliberately: an
unknown answer to "is this code live?" is not a yes. The script warns if it
finds any, because a column added without a default leaves a table full of them
and every one of those codes stops working with no other symptom.

One thing it will **not** touch: a `consume_offer_code` of your own with a
different signature — `(campaign text, code integer)`, say. Postgres keeps both
as overloads, so nothing breaks, but only `consume_offer_code(text, uuid)` is
the one the trigger calls. Drop yours once you have moved off it. If your column
was converted to `text`, yours will error when called — loudly, not silently.

One it **will**: `consume_offer_code(text, uuid)` itself now returns `text`
rather than `boolean` — `'ok'`, `'expired'`, `'used'` or `'invalid'` — so the
gate can say which. A return type cannot be changed by `create or replace`, so
the script drops that exact signature first. Anything of your own calling it and
expecting a boolean needs updating; `= 'ok'` is the replacement for a bare truth
test, and note that in SQL a non-empty string is not true.

The split stops at the gate. `offer_code_status`, the one the anon key can
reach, still answers only `ok` / `invalid` / `throttled` — telling a stranger
that a code is real but expired is the enumeration oracle the throttle exists to
prevent. Reaching the four-way answer costs an actual sign-up attempt, which
GoTrue rate limits and which leaves a record.

### The pre-check is rate limited

`offer_code_status` is callable by the anon key, which is what lets the form say
"check that code" at the step. Unthrottled, that is also a brute-force oracle,
and the arithmetic gets uncomfortable as you issue more codes. Seven digits with
a leading digit of 1–9 is a space of nine million:

| live codes | odds per guess | expected guesses to a hit | at 10 req/s |
|---|---|---|---|
| 100 | 1 in 90,000 | ~90,000 | ~2.5 hours |
| 2,000 | 1 in 4,500 | ~4,500 | **~7 minutes** |

So it is capped at **10 checks per 10 minutes per caller**, counted in
`public.offer_code_attempts` and keyed on the client address PostgREST reports
(`x-forwarded-for`, falling back to `cf-connecting-ip`). Both numbers live at
the top of the generated function; that is the only place to change them.

Three things about how it behaves, all deliberate:

- **A throttled caller is not refused a sign-up.** The function answers
  `'throttled'`, the form treats that exactly as it treats "cannot reach the
  bank" — waves them through — and the trigger decides at submit as it always
  would. The throttle takes away the cheap yes/no, not the ability to open an
  account.
- **Getting it right forgives the misses.** A correct code resets that caller's
  counter, so somebody who mistypes four times and then reads their invitation
  properly walks away clean. A script that only ever misses keeps every one.
- **An unidentifiable caller is not throttled at all.** No request headers means
  no PostgREST request — psql, a server-side call. Putting those in one shared
  bucket would mean the first script to run empties everyone's allowance and
  sign-up stops working for every real applicant at once. An availability
  failure to defend an enumeration risk is a bad trade.

**This does not cover sign-up itself.** GoTrue talks to Postgres directly rather
than through PostgREST, so the trigger has no headers to identify anyone by.
Guessing by repeated `auth.signUp` is governed by Supabase's own limits under
**Authentication → Rate Limits** — check that setting is sane.

The counter table is one row per client address, so it stays small. Prune it if
you like:

```sql
delete from public.offer_code_attempts where last_seen < now() - interval '7 days';
```

### Turning it off

For creating a user by hand in the Supabase dashboard, or to open sign-ups to
everyone:

```sql
update public.bank_settings set offer_code_required = false where id = 1;
-- ... add the user ...
update public.bank_settings set offer_code_required = true  where id = 1;
```

The switch lives in `bank_settings` so this never means dropping the trigger. It
defaults to **on**, because a gate that defaults to open is not a gate — and a
missing `bank_settings` row reads as on for the same reason.

### One thing to know about the error

When the trigger refuses, GoTrue does not always pass the reason through — on
most projects the browser gets a flat `Database error saving new user`. The app
reads that as an offer-code rejection (`js/auth-errors.js`), which is a guess,
but a good one here: the gate is the only trigger on `auth.users` that can
raise, and `handle_new_user` swallows everything it hits by design so that
provisioning can never fail a sign-up. The console always gets the raw error.

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
tells nobody anything. Section 13 of `setup.sql` creates it.

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
- [ ] Address / SSN-last-4 columns added if you want them off metadata (section 5)
- [ ] `user_profile` unique constraint, columns and RLS policies (section 5b) — **this is what makes address, phone and email saves work**
- [ ] Balance triggers installed on `transactions` (section 5c) — **the most important one left**
- [ ] `bank_settings.btc_usd_rate` added and set (section 5d)
- [ ] `deposit_requests` / `deposit_events` tables, secrets and the deployed webhook (section 5e)
- [ ] `statements` bucket (private), its read policy and the storage columns (section 5f) — only needed to serve the bank's own PDFs; downloads already work without it
- [ ] `external_accounts` table with the narrowed insert grant (section 5h) — **without it, linking a bank silently fails; without the grant, the 30-day hold is decoration**
- [ ] `offer_codes` table, the `on_auth_user_offer_code` trigger, **and at least one usable code** (section 5g) — **with the requirement on and no codes issued, nobody can sign up**
- [ ] `pg_cron` jobs scheduled, if you want the deadline enforced (section 6)
