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
- [ ] `pg_cron` jobs scheduled, if you want the deadline enforced (section 6)
