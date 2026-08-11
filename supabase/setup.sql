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
--   5. New user provisioning THE ONE THAT MAKES SIGN-UP DO SOMETHING
--   6. Balance triggers      THE ONE THAT MAKES BALANCES REAL
--   7. Identity lock
--   8. Realtime
--   9. Reference data
--  10. Verification          run this at the end and read the output
--  11. Optional: pg_cron
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

-- This section used to cover five tables. The app reads and writes THIRTY, and
-- the other twenty-five were left in whatever state they happened to be in:
--
--   • RLS off  → the anon key, which is in every visitor's browser, could read
--                every customer's investments, statements, support messages,
--                linked bank accounts and tax documents. All of them.
--   • RLS on with no policy → the table denies everything, and the screen that
--                reads it renders empty forever with no error anyone sees.
--
-- Both are here now, driven off one table of intent below, so there is a single
-- place to check what a customer session may do to each table.
--
-- The verbs, per table:
--   r  select  — always their own rows only
--   c  insert  — with check, so a row cannot be written under someone else's id
--   u  update  — only where a screen genuinely edits an existing row
--   d  delete  — only where a screen genuinely removes one
--
-- Anything that records something that happened gets r and c and nothing more.
-- A ledger a client can rewrite is not a ledger, an audit log a client can edit
-- is not an audit log, and a wire transfer a client can delete is not a record
-- of a wire transfer. Corrections are posted as new rows, or made with the
-- service key, which bypasses RLS entirely.

do $$
declare
  spec   record;
  pol    text;
  ownref text;
begin
  for spec in
    select * from (values
      -- ---- money and audit: written once, never altered ------------------
      ('transactions',             'user_id', 'rc'),
      ('activity_events',          'user_id', 'rc'),
      ('transfers',                'user_id', 'rc'),
      ('payments',                 'user_id', 'rc'),
      ('wire_transfers',           'user_id', 'rc'),
      ('external_transfers',       'user_id', 'rc'),
      ('investment_orders',        'user_id', 'rc'),
      ('card_reports',             'user_id', 'rc'),
      ('verification_requests',    'user_id', 'rc'),
      ('advisor_messages',         'user_id', 'rc'),
      ('support_messages',         'user_id', 'rc'),
      -- Issued by the bank; a customer may read theirs and nothing else.
      ('tax_documents',            'user_id', 'r'),
      ('account_documents',        'user_id', 'r'),
      ('deposit_requests',         'user_id', 'r'),

      -- ---- the record the bank holds on the customer ---------------------
      -- Update is allowed, but name and date of birth are held shut by the
      -- identity-lock trigger in section 7, not by this policy.
      ('user_profile',             'user_id', 'rcu'),
      ('profiles',                 'id',      'rcu'),

      -- ---- accounts ------------------------------------------------------
      -- Update is here because the app writes the account number it derives.
      -- It is narrowed to that ONE column by the grant below this block —
      -- without it, this policy would let any customer set their own balance.
      ('accounts',                 'user_id', 'rcu'),

      -- ---- preferences and settings, freely editable ---------------------
      ('card_settings',            'user_id', 'rcu'),
      ('privacy_settings',         'user_id', 'rcu'),
      ('notification_preferences', 'user_id', 'rcu'),
      ('notifications',            'user_id', 'rcu'),
      ('support_threads',          'user_id', 'rcu'),
      ('advisor_appointments',     'user_id', 'rcu'),
      ('investment_statements',    'user_id', 'rcu'),

      -- ---- lists the customer curates ------------------------------------
      ('watchlists',               'user_id', 'rcd'),
      ('investment_portfolio',     'user_id', 'rcud'),
      ('financial_goals',          'user_id', 'rcud'),
      ('scheduled_payments',       'user_id', 'rcud'),
      ('linked_accounts',          'user_id', 'rcud'),
      ('external_accounts',        'user_id', 'rcud')
    ) as t(tbl, col, verbs)
  loop
    if to_regclass('public.' || spec.tbl) is null then
      raise notice 'RLS: skipping %, table not present', spec.tbl;
      continue;
    end if;

    -- Enabling RLS on a table whose owner column is named something else would
    -- lock the app out of it completely, so the column is confirmed first.
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = spec.tbl and column_name = spec.col
    ) then
      raise warning 'RLS: % has no % column — LEFT UNSECURED, fix this by hand', spec.tbl, spec.col;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', spec.tbl);
    ownref := format('auth.uid() = %I', spec.col);

    foreach pol in array array['select', 'insert', 'update', 'delete'] loop
      execute format('drop policy if exists %I on public.%I', 'own_' || spec.tbl || '_' || pol, spec.tbl);
    end loop;

    execute format('create policy %I on public.%I for select using (%s)',
                   'own_' || spec.tbl || '_select', spec.tbl, ownref);

    if position('c' in spec.verbs) > 0 then
      execute format('create policy %I on public.%I for insert with check (%s)',
                     'own_' || spec.tbl || '_insert', spec.tbl, ownref);
    end if;

    -- USING decides which rows may be updated; WITH CHECK decides what they may
    -- be updated to. Without the second one a customer could hand their own row
    -- to another user_id, which is a row they then cannot see and cannot undo.
    if position('u' in spec.verbs) > 0 then
      execute format('create policy %I on public.%I for update using (%s) with check (%s)',
                     'own_' || spec.tbl || '_update', spec.tbl, ownref, ownref);
    end if;

    if position('d' in spec.verbs) > 0 then
      execute format('create policy %I on public.%I for delete using (%s)',
                     'own_' || spec.tbl || '_delete', spec.tbl, ownref);
    end if;

    raise notice 'RLS: % secured on %(%)', spec.tbl, spec.col, spec.verbs;
  end loop;
end $$;

-- The balance is the bank's number, not the customer's. RLS decides which ROWS
-- a session may touch; only a column grant decides which COLUMNS — so without
-- this, the update policy on `accounts` above is a licence to self-credit.
-- Balances move through the ledger triggers in section 6 and nowhere else.
do $$
begin
  if to_regclass('public.accounts') is not null then
    revoke update on public.accounts from authenticated;
    grant  update (account_number) on public.accounts to authenticated;
    raise notice 'accounts: update narrowed to account_number';
  end if;
end $$;

-- deposit_events gets RLS and no policy at all, which denies every customer
-- session by design. It holds raw exchange payloads and belongs to the bank;
-- the webhook writes it with the service key, which bypasses RLS.
alter table public.deposit_events enable row level security;

-- bank_settings is the one table every customer legitimately reads the same row
-- of, so it is not an "own rows" table and is secured in section 9 instead,
-- where the table itself is guaranteed to exist.

-- A last sweep for anything this file does not know about. A new table added
-- later and forgotten is exactly how the twenty-five above came to be exposed,
-- so this names any public table still without RLS instead of leaving it to be
-- noticed by someone else.
do $$
declare
  leaked text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into leaked
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relkind = 'r'
     and not c.relrowsecurity;
  if leaked is not null then
    raise warning 'TABLES WITH RLS OFF — readable by anyone holding the anon key: %', leaked;
  else
    raise notice 'every public table has RLS enabled';
  end if;
end $$;


-- =============================================================================
-- 5. NEW USER PROVISIONING
--
-- THE ONE THAT MAKES SIGN-UP DO SOMETHING.
--
-- Sign-up collects a name, a date of birth, the last four of an SSN, an address
-- and a chosen product, and hands the lot to Supabase as user metadata. Until
-- now that is where it stopped: the row landed in auth.users.raw_user_meta_data
-- and nothing in public ever read it. A brand-new customer signed in to a
-- dashboard with no profile row, no accounts, and no record of what they had
-- asked to open — so the app looked like it had lost the application.
--
-- This trigger unpacks the metadata the moment the auth user is created.
--
-- SECURITY DEFINER because it runs as the new user, before any session exists,
-- and RLS would otherwise refuse every insert here. search_path is pinned so
-- the definer rights cannot be aimed at a different schema.
--
-- THE WHOLE BODY IS WRAPPED IN AN EXCEPTION HANDLER, and that is not defensive
-- habit — it is the single most important line in this section. An error raised
-- in a trigger on auth.users aborts the INSERT that fired it, so a mistake here
-- does not degrade sign-up, it ENDS it: every applicant gets "Database error
-- saving new user" and no account is ever created. Provisioning is worth
-- failing quietly and fixing later. Sign-up is not.
--
-- (If sign-up is failing for you today with exactly that message, look for an
-- older handle_new_user on auth.users referencing a column that no longer
-- exists — it is the most common cause, and this replaces it.)
-- =============================================================================

-- The work itself, as an ordinary function rather than inside the trigger, so
-- the backfill at the end of this section can run exactly the same code over
-- customers who signed up before the trigger existed.
create or replace function public.provision_user(p_id uuid, p_email text, p_meta jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  meta       jsonb := coalesce(p_meta, '{}'::jsonb);
  new_id     uuid  := p_id;
  dob        date;
  wanted     text[];
  acct       text;
begin
  begin
    -- The date arrives as text from a browser date input. A value that will not
    -- cast is dropped rather than allowed to abort the sign-up.
    begin
      dob := nullif(meta->>'date_of_birth', '')::date;
    exception when others then
      dob := null;
    end;

    -- The bank's record of the customer. Every column here is guaranteed by
    -- section 3, so this cannot fail on a missing column.
    insert into public.user_profile (
      user_id, first_name, middle_name, last_name, suffix, date_of_birth,
      address_line1, address_line2, city, state, postal_code, ssn_last4,
      res_street, res_apt, res_city, res_state, res_zip,
      email, kyc_locked
    ) values (
      new_id,
      nullif(meta->>'first_name', ''),
      nullif(meta->>'middle_name', ''),
      nullif(meta->>'last_name', ''),
      nullif(meta->>'suffix', ''),
      dob,
      nullif(meta->>'address_line1', ''),
      nullif(meta->>'address_line2', ''),
      nullif(meta->>'city', ''),
      nullif(meta->>'state', ''),
      nullif(meta->>'postal_code', ''),
      nullif(meta->>'ssn_last4', ''),
      -- The residential address the profile screens read is the same address
      -- collected at sign-up. Written to both shapes so neither screen is blank.
      nullif(meta->>'address_line1', ''),
      nullif(meta->>'address_line2', ''),
      nullif(meta->>'city', ''),
      nullif(meta->>'state', ''),
      nullif(meta->>'postal_code', ''),
      p_email,
      true
    )
    on conflict (user_id) do nothing;

    -- The KYC status the dashboard gates full access on. Written dynamically
    -- because `profiles` predates this file and its shape is not guaranteed.
    if to_regclass('public.profiles') is not null then
      begin
        insert into public.profiles (id) values (new_id) on conflict (id) do nothing;
        if exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'profiles'
                      and column_name = 'kyc_status') then
          update public.profiles set kyc_status = coalesce(kyc_status, 'unverified')
           where id = new_id;
        end if;
      exception when others then
        raise warning 'handle_new_user: could not seed profiles for %: %', new_id, sqlerrm;
      end;
    end if;

    -- What they asked to open. Savings rides along with every product, which is
    -- the rule the sign-up screen states, so it is enforced here rather than
    -- trusted from the browser.
    if jsonb_typeof(meta->'requested_account_types') = 'array' then
      wanted := array(select jsonb_array_elements_text(meta->'requested_account_types'));
    else
      wanted := array[]::text[];
    end if;

    if coalesce(array_length(wanted, 1), 0) = 0 then
      wanted := array[coalesce(nullif(meta->>'requested_account_type', ''), 'checking')];
    end if;

    -- The cast is not decoration. Without it Postgres resolves this as
    -- array || array and tries to read the literal as an array, which fails
    -- with "malformed array literal" — inside the exception handler, so the
    -- only visible symptom is a customer with no accounts.
    if not ('savings' = any(wanted)) then
      wanted := wanted || 'savings'::text;
    end if;

    -- status 'pending', deliberately. Signing up is an application: nothing is
    -- open until identity is verified and the opening deposit has landed.
    -- Balance starts at zero and only the ledger triggers ever move it.
    if to_regclass('public.accounts') is not null then
      foreach acct in array wanted loop
        begin
          insert into public.accounts (user_id, account_type, balance, status)
          values (new_id, acct, 0, 'pending')
          on conflict (user_id, account_type) do nothing;
        exception when others then
          raise warning 'handle_new_user: could not open % for %: %', acct, new_id, sqlerrm;
        end;
      end loop;
    end if;

  exception when others then
    -- Never take sign-up down with us. See the note above.
    raise warning 'provision_user failed for % (%): %', new_id, p_email, sqlerrm;
  end;
end;
$$;

-- Nobody but the bank may call this: it writes rows for an arbitrary user id
-- with definer rights, so an authenticated session that could reach it could
-- provision anybody.
revoke all on function public.provision_user(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.provision_user(new.id, new.email, new.raw_user_meta_data);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill: anyone who signed up before this trigger existed has their details
-- sitting on the auth user and nothing at all in public. This gives them the
-- rows a new applicant now gets, using the very same function.
--
-- Safe to re-run, and safe on a live bank: every insert inside is ON CONFLICT
-- DO NOTHING, so an existing customer's profile, balances and accounts are
-- never touched. Only users with no profile row at all are considered.
do $$
declare
  u record;
  n int := 0;
begin
  for u in select id, email, raw_user_meta_data from auth.users loop
    if not exists (select 1 from public.user_profile where user_id = u.id) then
      perform public.provision_user(u.id, u.email, u.raw_user_meta_data);
      n := n + 1;
    end if;
  end loop;
  raise notice 'provisioned % pre-existing user(s)', n;
end $$;


-- =============================================================================
-- 6. BALANCE TRIGGERS
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
-- 7. IDENTITY LOCK
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
-- 8. REALTIME
--
-- So a credit posted by a representative, or a transfer made on another device,
-- reaches an open screen without a refresh.
--
-- A table that is not in this publication produces a channel that JOINS
-- SUCCESSFULLY and then never delivers anything. There is no error and nothing
-- on the console — the screen simply never updates, which looks exactly like an
-- account where nothing has happened. That is why `notifications` mattered: the
-- app has subscribed to it all along and it was never published, so the bell
-- has never once lit up on its own.
-- =============================================================================

-- The publication is created by Supabase, but not on every project and not
-- under every template. Without this guard the ALTER below fails and takes the
-- rest of the file with it.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
    raise notice 'created the supabase_realtime publication';
  end if;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['transactions', 'activity_events', 'accounts', 'notifications'] loop
    if to_regclass('public.' || t) is null then
      raise notice 'realtime: skipping %, table not present', t;
      continue;
    end if;
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
      raise notice 'added % to supabase_realtime', t;
    else
      raise notice '% is already published', t;
    end if;
  end loop;
end $$;

-- REPLICA IDENTITY on `accounts`, and only on `accounts`.
--
-- By default Postgres puts just the primary key of the old row into the WAL.
-- Realtime applies RLS to a DELETE by testing the OLD record — and a record
-- consisting of nothing but an id has no user_id to test, so the policy cannot
-- pass and the event is dropped. Every other subscription in the app listens
-- for INSERT only, where the new row is complete; `accounts` is the one that
-- listens for '*'.
--
-- The cost is a larger WAL for updates to this table, which for a table with
-- one row per account per customer is not a consideration.
do $$
begin
  if to_regclass('public.accounts') is not null then
    alter table public.accounts replica identity full;
    raise notice 'accounts: replica identity full (delete events now carry user_id)';
  end if;
end $$;


-- =============================================================================
-- 9. REFERENCE DATA
-- =============================================================================

-- Created rather than assumed. This block used to open with a bare ALTER TABLE,
-- so on a project that had never had this table the whole file stopped here —
-- and everything below it, including the verification section, never ran.
create table if not exists public.bank_settings (
  id int primary key
);

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

-- The one table every customer reads the same row of. Readable by any signed-in
-- session, writable by none of them — the rate is the bank's number, and a
-- customer who could edit it could choose what their own deposit was worth.
alter table public.bank_settings enable row level security;
drop policy if exists "bank settings readable" on public.bank_settings;
create policy "bank settings readable"
  on public.bank_settings for select to authenticated using (true);
revoke insert, update, delete on public.bank_settings from authenticated, anon;


-- =============================================================================
-- 10. VERIFICATION
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

-- RLS on, AND at least one policy. On is not enough on its own: a table with
-- RLS enabled and no policy denies everything, which looks to the app exactly
-- like a table that is simply always empty. Off is worse — it means the anon
-- key in every visitor's browser can read the whole table.
union all
select 'row level security', c.relname,
       case when not c.relrowsecurity then 'EXPOSED — rls off'
            when exists (select 1 from pg_policy p where p.polrelid = c.oid) then 'ok'
            -- The one table that is meant to have no policy: raw exchange
            -- payloads, written by the webhook with the service key.
            when c.relname = 'deposit_events' then 'ok (bank only, no customer access)'
            else 'DENY-ALL — rls on, no policy; the app will read this as empty'
       end
  from pg_class c
 where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'

-- The balance column must not be client-writable, whatever the policies say.
union all
select 'column grant', 'accounts.balance not writable by customers',
       case when has_column_privilege('authenticated', 'public.accounts', 'balance', 'UPDATE')
            then 'EXPOSED — customers can set their own balance' else 'ok' end

union all
select 'balance trigger', tgname,
       case when count(*) > 0 then 'ok' else 'MISSING' end
  from pg_trigger
 where tgname in ('apply_transaction_to_balance','apply_settled_transaction','freeze_verified_identity')
 group by tgname

-- Without this, signing up creates an auth user and nothing else: no profile,
-- no accounts, and a dashboard with nothing in it.
union all
select 'sign-up trigger', 'on_auth_user_created',
       case when exists (select 1 from pg_trigger where tgname = 'on_auth_user_created'
                           and tgrelid = 'auth.users'::regclass)
            then 'ok' else 'MISSING' end

-- Checked against what the app subscribes to, rather than listing whatever
-- happens to be published. A missing table here is a screen that never updates,
-- with no error anywhere to say so.
union all
select 'realtime', t,
       case when to_regclass('public.' || t) is null then 'table missing'
            when exists (select 1 from pg_publication_tables
                          where pubname = 'supabase_realtime'
                            and schemaname = 'public' and tablename = t)
            then 'ok' else 'MISSING — this screen will never update live' end
  from unnest(array['transactions','activity_events','accounts','notifications']) as t

union all
select 'realtime', 'accounts replica identity',
       case when to_regclass('public.accounts') is null then 'table missing'
            when (select relreplident from pg_class where oid = 'public.accounts'::regclass) = 'f'
            then 'ok' else 'MISSING — delete events will be dropped by RLS' end

order by 1, 3 desc, 2;


-- Anyone whose auth user exists but who has no profile row. Should be empty:
-- a non-empty result means section 5 did not run, or its backfill hit a
-- warning — check the Postgres logs for 'provision_user failed'.
select u.id, u.email, u.created_at
  from auth.users u
  left join public.user_profile p on p.user_id = u.id
 where p.user_id is null;


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
-- 11. OPTIONAL — pg_cron
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
