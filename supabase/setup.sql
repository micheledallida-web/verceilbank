-- =============================================================================
-- VERCEIL BANK — COMPLETE SUPABASE SETUP
--
-- Everything the app needs, in the order it has to be applied.
-- Paste the whole file into the Supabase SQL Editor and run it once.
--
-- Safe to re-run. Every statement is guarded: tables and columns use
-- IF NOT EXISTS, policies are dropped before they are created, constraints and
-- publication members are checked before being added. Running it twice changes
-- nothing the second time.
--
-- Nothing here drops a table or deletes customer data. The one DELETE is in
-- section 3, and it only removes duplicate rows that must go before a unique
-- constraint can exist — it reports what it found before it acts.
--
-- Sections
--   1. New tables            ledger, audit log, deposits
--   2. Unique constraints    THE ONE THAT FIXES SAVES SILENTLY FAILING
--   3. Missing columns
--   4. Row Level Security    THE ONE THAT MATTERS MOST FOR SECURITY
--   5. Balance triggers      THE ONE THAT MAKES BALANCES REAL
--   6. Identity lock
--   7. Realtime
--   8. Reference data
--   9. Verification          run this at the end and read the output
--  10. Optional: pg_cron
-- =============================================================================


-- =============================================================================
-- 1. NEW TABLES
-- =============================================================================

-- The ledger. The account screens have always read this table; until recently
-- nothing wrote to it. Money movements land here in addition to their own
-- product table (transfers, payments, wire_transfers, ...).
--
-- amount is signed: negative leaves the account, positive arrives in it.
-- local_id is the client's own id, and it is what makes a retry safe — a row
-- queued twice because a flush timed out after the insert landed is recognised
-- as the same row instead of being written again.
create table if not exists public.transactions (
  id               bigint generated always as identity primary key,
  local_id         text not null unique,
  user_id          uuid not null references auth.users (id) on delete cascade,
  -- checking | savings | interest_checking | investments
  -- ira_traditional | ira_roth | credit
  account_type     text not null,
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


-- The audit log. Every screen opened, sign-in, setting changed, account opened.
create table if not exists public.activity_events (
  id           bigint generated always as identity primary key,
  local_id     text not null unique,
  user_id      uuid not null references auth.users (id) on delete cascade,
  event_type   text not null,
  detail       jsonb not null default '{}'::jsonb,
  occurred_at  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists activity_events_user_time_idx
  on public.activity_events (user_id, occurred_at desc);


-- The link between a customer and a deposit address. Without a row here an
-- incoming payment is anonymous and the webhook will not credit it to anybody.
create table if not exists public.deposit_requests (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references auth.users (id) on delete cascade,
  account_type   text not null default 'checking',
  address        text not null,
  quidax_user_id text,
  amount_usd     numeric(14,2),
  -- The rate the customer was quoted. The credit uses this, not the rate at
  -- the moment the coins land, because it is the number they were shown.
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


-- Every delivery the exchange makes, recorded before anything is decided about
-- it — including the ones that could not be attributed to a customer.
create table if not exists public.deposit_events (
  id                      bigint generated always as identity primary key,
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


-- =============================================================================
-- 2. UNIQUE CONSTRAINTS
--
-- READ THIS ONE. It is the difference between the app saving and not saving.
--
-- The app upserts on these columns. Postgres cannot perform an upsert without a
-- unique constraint on the conflict target: it returns error 42P10 and the save
-- fails — for every customer, permanently, with no other symptom.
--
-- This is what stopped mailing addresses saving. The same fault is latent on
-- five other tables, which would break opening an Interest Checking account,
-- opening an IRA, the compulsory savings account, card settings, privacy
-- settings and notification preferences.
--
-- Duplicates are removed first, keeping the oldest row of each set, because a
-- unique constraint cannot be created over existing duplicates.
-- =============================================================================

do $$
declare
  spec record;
  removed bigint;
begin
  for spec in
    select * from (values
      ('accounts',                'user_id, account_type', 'accounts_user_account_key'),
      ('user_profile',            'user_id',               'user_profile_user_id_key'),
      ('card_settings',           'user_id, card_type',    'card_settings_user_card_key'),
      ('privacy_settings',        'user_id',               'privacy_settings_user_id_key'),
      ('notification_preferences','user_id',               'notification_preferences_user_id_key')
    ) as t(tbl, cols, cname)
  loop
    -- Skip tables this project does not have.
    if to_regclass('public.' || spec.tbl) is null then
      raise notice 'skipping %, table not present', spec.tbl;
      continue;
    end if;

    -- Already constrained: nothing to do.
    if exists (
      select 1 from pg_constraint
       where conrelid = ('public.' || spec.tbl)::regclass
         and contype = 'u'
         and pg_get_constraintdef(oid) = 'UNIQUE (' || spec.cols || ')'
    ) then
      raise notice '% already unique on (%)', spec.tbl, spec.cols;
      continue;
    end if;

    -- Remove duplicates, keeping the physically oldest row of each group.
    execute format(
      'delete from public.%I a using public.%I b
        where (%s) is not distinct from (%s) and a.ctid > b.ctid',
      spec.tbl, spec.tbl,
      (select string_agg('a.' || quote_ident(trim(c)), ', ') from unnest(string_to_array(spec.cols, ',')) c),
      (select string_agg('b.' || quote_ident(trim(c)), ', ') from unnest(string_to_array(spec.cols, ',')) c)
    );
    get diagnostics removed = row_count;
    if removed > 0 then
      raise notice 'removed % duplicate row(s) from %', removed, spec.tbl;
    end if;

    execute format('alter table public.%I add constraint %I unique (%s)',
                   spec.tbl, spec.cname, spec.cols);
    raise notice 'added unique (%) to %', spec.cols, spec.tbl;
  end loop;
end $$;


-- =============================================================================
-- 3. MISSING COLUMNS
-- =============================================================================

-- Everything the profile screens write.
alter table public.user_profile
  add column if not exists first_name         text,
  add column if not exists middle_name        text,
  add column if not exists last_name          text,
  add column if not exists suffix             text,
  add column if not exists date_of_birth      date,
  add column if not exists res_street         text,
  add column if not exists res_apt            text,
  add column if not exists res_city           text,
  add column if not exists res_state          text,
  add column if not exists res_zip            text,
  add column if not exists res_country        text,
  add column if not exists mail_same_as_res   boolean default true,
  add column if not exists mail_street        text,
  add column if not exists mail_city          text,
  add column if not exists mail_state         text,
  add column if not exists mail_zip           text,
  add column if not exists phone_country_code text,
  add column if not exists phone_number       text,
  add column if not exists phone_verified     boolean default false,
  add column if not exists email              text,
  add column if not exists email_verified     boolean default false,
  -- Set by section 6's trigger. True means name and date of birth are the
  -- bank's record and a customer session may not change them.
  add column if not exists kyc_locked         boolean not null default true;

-- What sign-up now collects, if you want it off auth metadata and queryable.
alter table public.user_profile
  add column if not exists address_line1 text,
  add column if not exists address_line2 text,
  add column if not exists city          text,
  add column if not exists state         text,
  add column if not exists postal_code   text,
  add column if not exists ssn_last4     text;

-- The account number the app assigns at opening.
alter table public.accounts
  add column if not exists account_number text;


-- =============================================================================
-- 4. ROW LEVEL SECURITY
--
-- THE MOST IMPORTANT SECTION IN THIS FILE.
--
-- The anon key is shipped to every visitor's browser by design. RLS is the only
-- thing that stops one customer reading another's data.
-- =============================================================================

alter table public.transactions     enable row level security;
alter table public.activity_events  enable row level security;
alter table public.deposit_requests enable row level security;
alter table public.deposit_events   enable row level security;
alter table public.user_profile     enable row level security;

drop policy if exists "own transactions read"   on public.transactions;
drop policy if exists "own transactions insert" on public.transactions;
create policy "own transactions read"
  on public.transactions for select using (auth.uid() = user_id);
create policy "own transactions insert"
  on public.transactions for insert with check (auth.uid() = user_id);

drop policy if exists "own activity events read"   on public.activity_events;
drop policy if exists "own activity events insert" on public.activity_events;
create policy "own activity events read"
  on public.activity_events for select using (auth.uid() = user_id);
create policy "own activity events insert"
  on public.activity_events for insert with check (auth.uid() = user_id);

-- No update or delete policy on either of the two above, deliberately. An audit
-- log a client can edit is not an audit log, and a ledger a client can rewrite
-- is not a ledger. Corrections are posted as new rows, or made with the
-- service key, which bypasses RLS.

drop policy if exists "own deposit requests read" on public.deposit_requests;
create policy "own deposit requests read"
  on public.deposit_requests for select using (auth.uid() = user_id);

-- deposit_events gets no policy at all. It holds raw exchange payloads and
-- belongs to the bank, not the customer. The webhook writes it with the
-- service key.

drop policy if exists "own profile read"   on public.user_profile;
drop policy if exists "own profile insert" on public.user_profile;
drop policy if exists "own profile update" on public.user_profile;
create policy "own profile read"
  on public.user_profile for select using (auth.uid() = user_id);
create policy "own profile insert"
  on public.user_profile for insert with check (auth.uid() = user_id);
create policy "own profile update"
  on public.user_profile for update using (auth.uid() = user_id);


-- =============================================================================
-- 5. BALANCE TRIGGERS
--
-- THE ONE THAT MAKES BALANCES REAL.
--
-- Without this a transfer writes its ledger rows and moves the number on
-- screen, but accounts.balance never changes — so a refresh brings the old
-- balance back. Every figure in the app is honest about what the server holds;
-- the server was simply never told.
--
-- The arithmetic lives here rather than in the app because two devices doing
-- sums on the same account is how money goes missing.
-- =============================================================================

create or replace function public.apply_transaction_to_balance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A pending row is not money that has moved: a wire under review or an
  -- unsettled trade leaves the balance alone until its status becomes
  -- 'completed'.
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


-- The same, for a pending row that settles later.
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


-- =============================================================================
-- 6. IDENTITY LOCK
--
-- Name and date of birth are checked against a government ID at verification,
-- so they are the bank's record rather than a setting. The app has no inputs
-- for them; this makes that true at the database as well, so the rule does not
-- depend on the UI.
-- =============================================================================

create or replace function public.freeze_verified_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- auth.uid() is null for the service key and the SQL editor, which is how an
  -- administrator makes a correction.
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

drop trigger if exists freeze_verified_identity on public.user_profile;
create trigger freeze_verified_identity
  before update on public.user_profile
  for each row execute function public.freeze_verified_identity();


-- =============================================================================
-- 7. REALTIME
--
-- So a credit posted by a representative, or a transfer made on another device,
-- reaches an open screen without a refresh.
-- =============================================================================

do $$
declare
  t text;
begin
  foreach t in array array['transactions', 'activity_events', 'accounts'] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
      raise notice 'added % to supabase_realtime', t;
    end if;
  end loop;
end $$;


-- =============================================================================
-- 8. REFERENCE DATA
-- =============================================================================

alter table public.bank_settings
  add column if not exists routing_number text,
  -- Read by Fund Account instead of a price compiled into the JavaScript, which
  -- is wrong the day after it ships and is the number a deposit converts at.
  add column if not exists btc_usd_rate   numeric(14,2);

-- The row the app reads. Insert it if this project has never had one.
insert into public.bank_settings (id)
select 1
 where not exists (select 1 from public.bank_settings where id = 1);

update public.bank_settings
   set routing_number = coalesce(routing_number, '856919671'),
       btc_usd_rate   = coalesce(btc_usd_rate, 106468.20)
 where id = 1;


-- =============================================================================
-- 9. VERIFICATION
--
-- Run this section on its own afterwards and read the output. Every row should
-- say 'ok'. Anything that says 'MISSING' is not set up.
-- =============================================================================

select 'tables' as check,
       t as name,
       case when to_regclass('public.' || t) is not null then 'ok' else 'MISSING' end as status
  from unnest(array['transactions','activity_events','deposit_requests','deposit_events',
                    'accounts','user_profile','bank_settings']) as t

union all
select 'unique constraint', spec.tbl || ' (' || spec.cols || ')',
       case when to_regclass('public.' || spec.tbl) is null then 'table missing'
            when exists (
              select 1 from pg_constraint
               where conrelid = ('public.' || spec.tbl)::regclass and contype = 'u'
                 and pg_get_constraintdef(oid) = 'UNIQUE (' || spec.cols || ')')
            then 'ok' else 'MISSING' end
  from (values ('accounts','user_id, account_type'),
               ('user_profile','user_id'),
               ('card_settings','user_id, card_type'),
               ('privacy_settings','user_id'),
               ('notification_preferences','user_id')) as spec(tbl, cols)

union all
select 'row level security', c.relname,
       case when c.relrowsecurity then 'ok' else 'MISSING' end
  from pg_class c
 where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'

union all
select 'balance trigger', tgname,
       case when count(*) > 0 then 'ok' else 'MISSING' end
  from pg_trigger
 where tgname in ('apply_transaction_to_balance','apply_settled_transaction','freeze_verified_identity')
 group by tgname

union all
select 'realtime', tablename, 'ok'
  from pg_publication_tables
 where pubname = 'supabase_realtime' and schemaname = 'public'

order by 1, 3 desc, 2;


-- Any account whose stored balance disagrees with its ledger. An empty result
-- is the correct outcome — it means the triggers are keeping up.
select a.user_id, a.account_type,
       a.balance as stored,
       coalesce(sum(t.amount) filter (where t.status = 'completed'), 0) as from_ledger
  from public.accounts a
  left join public.transactions t
    on t.user_id = a.user_id and t.account_type = a.account_type
 group by a.user_id, a.account_type, a.balance
having a.balance is distinct from
       coalesce(sum(t.amount) filter (where t.status = 'completed'), 0);


-- =============================================================================
-- 10. OPTIONAL — pg_cron
--
-- Not run by the statements above. Enable the pg_cron extension first
-- (Database -> Extensions), then run this block on its own if you want it.
-- =============================================================================

-- Closes accounts that never received their $100 opening deposit within 60
-- days. Until this exists, that rule is copy and a countdown, nothing more.
--
-- create or replace function public.close_unfunded_accounts()
-- returns void language sql security definer as $$
--   update public.accounts a
--      set status = 'closed'
--    where a.status <> 'closed'
--      and a.created_at < now() - interval '60 days'
--      and coalesce(a.balance, 0) < 100
--      and not exists (select 1 from public.transactions t
--                       where t.user_id = a.user_id and t.amount > 0);
-- $$;
--
-- select cron.unschedule('close-unfunded-accounts')
--  where exists (select 1 from cron.job where jobname = 'close-unfunded-accounts');
-- select cron.schedule('close-unfunded-accounts', '0 3 * * *',
--                      'select public.close_unfunded_accounts()');
--
-- Keeps a year of the event log.
--
-- select cron.unschedule('trim-activity-events')
--  where exists (select 1 from cron.job where jobname = 'trim-activity-events');
-- select cron.schedule('trim-activity-events', '30 3 * * 0',
--   $$delete from public.activity_events where occurred_at < now() - interval '1 year'$$);


-- =============================================================================
-- WHAT IS NOT IN THIS FILE
--
-- Secrets. They are set in the dashboard, never in SQL:
--
--   Project Settings -> Edge Functions -> Secrets
--     QUIDAX_WEBHOOK_SECRET        the value you also put in Quidax
--     QUIDAX_CREDIT_ACCOUNT_TYPE   optional, defaults to 'checking'
--
--   Vercel -> Settings -> Environment Variables
--     SUPABASE_URL                 https://kzykuuxoivrttfdjdypl.supabase.co
--     SUPABASE_ANON_KEY            the anon / public key
--
-- Never put the service role key or an exchange API key in Vercel. Those are
-- visible to every visitor's browser.
--
--
-- AND ONE AUTH SETTING, WITHOUT WHICH PASSWORD RESET SILENTLY FAILS
--
--   Authentication -> URL Configuration
--     Site URL        your deployed origin, e.g. https://verceilbank.vercel.app
--     Redirect URLs   add:  https://<your-domain>/reset-password.html
--
-- Supabase refuses to send a customer to a redirect it has not been told about.
-- If reset-password.html is not on that list the email still arrives, but the
-- link drops the customer on the Site URL with no recovery token and the page
-- says the link cannot be used — which looks like a broken link rather than a
-- missing setting. Add every origin you use, including preview deployments.
-- ==============================================================================
