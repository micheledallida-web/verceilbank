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
--  10. Identity verification THE ONE THAT MAKES ID UPLOAD WORK
--  11. Statement files       THE ONE THAT MAKES DOWNLOAD PDF HAND OVER A FILE
--  12. Offer codes           THE ONE THAT MAKES SIGN-UP INVITE-ONLY
--  13. Verification          run this at the end and read the output
--  14. Optional: pg_cron
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
  add column if not exists ssn_last4     text,
  -- The seven-digit code the account was opened with. Added here rather than
  -- in section 12 where the rest of the offer-code machinery lives, because
  -- provision_user writes it and provision_user runs — over every existing
  -- customer — in section 5, long before section 12 is reached.
  add column if not exists offer_code    text;

-- The account number the app assigns at opening, and who owns the account.
--
-- `ownership` is 'individual' for every account a customer opens themselves.
-- Only the bank ever writes 'joint', and only once both owners have been
-- identified and the ownership agreement has been countersigned — the insert
-- grant in section 4 is what makes that true rather than a convention.
alter table public.accounts
  add column if not exists account_number text,
  add column if not exists ownership     text not null default 'individual';

do $$
begin
  if to_regclass('public.accounts') is null then
    raise notice 'accounts: table not present, skipping ownership constraint';
    return;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.accounts'::regclass and conname = 'accounts_ownership_check'
  ) then
    alter table public.accounts
      add constraint accounts_ownership_check check (ownership in ('individual', 'joint'));
    raise notice 'accounts: ownership constrained to individual|joint';
  end if;
exception when others then
  -- A project whose existing rows carry some other ownership value keeps them,
  -- and keeps its sign-up working. The constraint is a guard rail, not a
  -- reason to stop the whole setup.
  raise warning 'accounts: could not constrain ownership: %', sqlerrm;
end $$;

-- Defaults for the two columns a customer session is about to lose the right to
-- write (see section 4). Without these an insert that omits them would fail on
-- a NOT NULL, or open an account with a null balance.
--
-- 'pending' is deliberate, and it is the same status new-user provisioning
-- uses: signing up or opening an account is an application. Nothing is fully
-- open until identity is verified and the opening deposit has landed.
do $$
begin
  if to_regclass('public.accounts') is null then
    raise notice 'accounts: table not present, skipping column defaults';
    return;
  end if;

  begin
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'accounts' and column_name = 'balance') then
      alter table public.accounts alter column balance set default 0;
      raise notice 'accounts: balance defaults to 0';
    end if;
  exception when others then
    raise warning 'accounts: could not default balance: %', sqlerrm;
  end;

  -- Guarded separately: a project whose `status` is an enum rather than text
  -- would reject the literal, and that must not take the setup down on its way
  -- past. The column is left without a default there, which is survivable —
  -- the app reads a null status as "not closed", so the account still works.
  begin
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'accounts' and column_name = 'status') then
      alter table public.accounts alter column status set default 'pending';
      raise notice 'accounts: status defaults to pending';
    end if;
  exception when others then
    raise warning 'accounts: could not default status: %', sqlerrm;
  end;
end $$;


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
      -- The customer opens their own deposit request from the Fund Account
      -- screen, so insert is theirs. Update is NOT: the status only ever moves
      -- to 'credited' by the webhook, holding the service key. A customer who
      -- could write that column could mark their own deposit as received.
      ('deposit_requests',         'user_id', 'rc'),

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
--
-- INSERT needs exactly the same treatment, and used not to have it. The insert
-- policy above checks WHOSE row is being written; it says nothing about what is
-- in it. So a customer session could open an account for itself — which is
-- allowed, that is what the Open an Account screen does — and set the balance
-- on it in the same statement. Opening an account with a million dollars in it
-- is one request. The update grant closed the front door and left this open.
--
-- Two columns are all a customer needs to open an account: whose it is, and
-- which product. Everything else takes its default: balance 0, status pending,
-- ownership individual. A joint account is therefore something only the bank
-- can write, which is the rule the Joint Accounts screen describes.
do $$
begin
  if to_regclass('public.accounts') is not null then
    revoke update on public.accounts from authenticated;
    grant  update (account_number) on public.accounts to authenticated;
    raise notice 'accounts: update narrowed to account_number';

    revoke insert on public.accounts from authenticated;
    grant  insert (user_id, account_type) on public.accounts to authenticated;
    raise notice 'accounts: insert narrowed to user_id, account_type';
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
      email, offer_code, kyc_locked
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
      -- Which code opened this account. By the time this runs the BEFORE INSERT
      -- trigger in section 12 has already spent it, so this is a copy for
      -- reading, not the record of the spend — `offer_code_redemptions` is that.
      -- Null on every customer who signed up before the codes existed.
      nullif(trim(coalesce(meta->>'offer_code', '')), ''),
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
-- sitting on the auth user and not all of them in public. This gives them the
-- rows a new applicant now gets, using the very same function.
--
-- THE CONDITION IS THE WHOLE POINT, AND IT USED TO BE WRONG. It considered only
-- users with no `user_profile` row, on the assumption that a customer either
-- has everything or nothing. That is not the shape the gap actually takes: an
-- earlier version of this app wrote a profile row at sign-up and never opened
-- any accounts, so those customers have a profile, no accounts, and were
-- skipped by this loop every single time it ran.
--
-- What that costs them is not cosmetic. `accounts` is where a balance lives,
-- and section 6's triggers move a balance with
-- `update public.accounts ... where user_id = ... and account_type = ...`. With
-- no row to match, every deposit and every transfer updates NOTHING. Their
-- money moves in the ledger and their balance never changes — an account that
-- has quietly stopped working, which is exactly what it looks like from the
-- customer's side. The most recent sign-ups are fine, because by then the
-- trigger above existed, so the fault reads as "my first accounts are broken
-- and only the newest one works".
--
-- A missing profile OR missing accounts now brings a customer back through
-- provisioning. Safe to re-run, and safe on a live bank: every insert inside
-- provision_user is ON CONFLICT DO NOTHING, so an existing customer's profile,
-- balances and accounts are never touched — the function only ever fills gaps.
do $$
declare
  u record;
  n int := 0;
  fixed_accounts int := 0;
  has_accounts boolean := to_regclass('public.accounts') is not null;
begin
  for u in select id, email, raw_user_meta_data from auth.users loop
    if not exists (select 1 from public.user_profile where user_id = u.id)
       or (has_accounts and not exists (select 1 from public.accounts where user_id = u.id))
    then
      if has_accounts and not exists (select 1 from public.accounts where user_id = u.id) then
        fixed_accounts := fixed_accounts + 1;
      end if;
      perform public.provision_user(u.id, u.email, u.raw_user_meta_data);
      n := n + 1;
    end if;
  end loop;
  raise notice 'provisioned % pre-existing user(s); % of them had no accounts at all', n, fixed_accounts;
end $$;

-- And the check that says whether it worked. A customer with no accounts row
-- after everything above has run is a customer whose balance cannot move, so it
-- is reported loudly rather than left to be discovered by the person it belongs
-- to.
do $$
declare
  stranded text;
begin
  if to_regclass('public.accounts') is null then return; end if;
  select string_agg(u.email, ', ' order by u.email) into stranded
    from auth.users u
   where not exists (select 1 from public.accounts a where a.user_id = u.id);
  if stranded is not null then
    raise warning 'CUSTOMERS WITH NO ACCOUNTS — their balances cannot move: %', stranded;
  else
    raise notice 'every customer holds at least one account';
  end if;
end $$;


-- Giving a repaired account back the money the ledger already knows about.
--
-- Reopening the account is only half of it. The balance triggers in section 6
-- fire on a ledger row as it is written; they do not replay history. So a
-- customer who banked for weeks with no `accounts` row has every deposit and
-- every payment sitting in `transactions` and an account that has just come
-- back reading zero. Their money is not lost — it is in the ledger, which is
-- the record that matters — but nothing has told the balance about it.
--
-- The ledger is the source of truth and `accounts.balance` is a cache of it, so
-- the cache is rebuilt from the ledger. 'completed' is the same test the
-- trigger applies, so a pending trade is left out here exactly as it is there.
--
-- THE CONDITION IS NARROW ON PURPOSE: only an account sitting at exactly zero
-- whose ledger says otherwise. That is unambiguous — it can only be an account
-- that missed its own history. Any other disagreement between a balance and its
-- ledger is a different fault, and one this file must not paper over: a
-- representative's manual correction, posted with the service key, is a real
-- adjustment and rewriting it from the ledger would silently undo it. Section
-- 10 reports those instead, and a person decides.
do $$
declare
  r      record;
  n      int := 0;
  total  numeric := 0;
begin
  if to_regclass('public.accounts') is null or to_regclass('public.transactions') is null then
    return;
  end if;

  for r in
    select a.id,
           coalesce(sum(t.amount) filter (where t.status = 'completed'), 0) as from_ledger
      from public.accounts a
      join public.transactions t
        on t.user_id = a.user_id and t.account_type = a.account_type
     where coalesce(a.balance, 0) = 0
     group by a.id
    having coalesce(sum(t.amount) filter (where t.status = 'completed'), 0) <> 0
  loop
    update public.accounts set balance = r.from_ledger where id = r.id;
    n := n + 1;
    total := total + r.from_ledger;
  end loop;

  if n > 0 then
    raise notice 'reconciled % account(s) from their ledger — % restored in total', n, total;
  else
    raise notice 'no balances needed restoring from the ledger';
  end if;
exception when others then
  -- Never take the setup down over this. The accounts are open either way, and
  -- section 10 will report anything still out of step.
  raise warning 'balance reconciliation skipped: %', sqlerrm;
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
--
-- `deposit_events` is deliberately NOT here, and must not be added. It holds
-- raw exchange payloads — every customer's deposit address, amounts, exchange
-- user ids, and the payments that could not be attributed to anybody. It is the
-- bank's table, it has RLS with no policy, and a browser subscribing to it
-- would either receive nothing (RLS refusing, which is what happens today) or,
-- if a policy were added to "make it work", hand one customer the deposit
-- traffic of every other. The customer-facing half of the same event is
-- `deposit_requests` — their own row, their own status — and that is what is
-- published below.
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
  foreach t in array array['transactions', 'activity_events', 'accounts',
                           'notifications', 'deposit_requests'] loop
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
-- 10. IDENTITY VERIFICATION — THE TABLE AND THE DOCUMENT BUCKET
--
-- THE ONE THAT MAKES ID UPLOAD WORK AT ALL.
--
-- The Verify screen uploads three photos to a storage bucket called
-- `kyc-documents` and then writes a row to `verification_requests` holding the
-- paths. Neither existed. The upload failed, the row was never written, and
-- nobody could verify their identity — which gates moving money, so it gated
-- the whole account.
--
-- The client writes each file to  <user-id>/<name>.<ext>  so the first folder
-- in the path IS the owner. That is what the storage policies below check.
-- =============================================================================

create table if not exists public.verification_requests (
  id                bigint generated always as identity primary key,
  user_id           uuid not null references auth.users (id) on delete cascade,
  submitted_at      timestamptz not null default now(),
  status            text not null default 'pending'
);

-- Every field the Verify screen sends. Added separately so a project that
-- already has this table gains only what it is missing.
alter table public.verification_requests
  -- These two are in the CREATE above as well, and they have to be here too:
  -- a project that already has this table skips the CREATE entirely, and the
  -- index below is on submitted_at. Leaving them out of this list is why the
  -- file failed against a database that already had the table.
  add column if not exists submitted_at     timestamptz not null default now(),
  add column if not exists status           text not null default 'pending',
  add column if not exists legal_first_name text,
  add column if not exists legal_last_name  text,
  add column if not exists date_of_birth    date,
  add column if not exists ssn              text,
  add column if not exists address_line1    text,
  add column if not exists address_line2    text,
  add column if not exists city             text,
  add column if not exists state            text,
  add column if not exists postal_code      text,
  add column if not exists id_type          text,
  -- Storage paths, not the images. The files live in the bucket below.
  add column if not exists id_front_path    text,
  add column if not exists id_back_path     text,
  add column if not exists selfie_path      text,
  -- Filled by whoever reviews it.
  add column if not exists reviewed_at      timestamptz,
  add column if not exists rejection_reason text;

create index if not exists verification_requests_user_idx
  on public.verification_requests (user_id, submitted_at desc);

-- The Social Security number is the most sensitive column in this database.
-- The app WRITES it and never reads it back — the Verify screen submits it and
-- nothing selects it — so the read is taken away entirely. A customer session
-- can still insert a request and still read its status; it just cannot ask the
-- database to hand an SSN back to a browser, which is the shape of every
-- account-takeover that starts with a stolen session.
--
-- Review it with the service key, or through a view that does not carry it.
-- Revoking the COLUMN is not enough and quietly does nothing: a column-level
-- revoke cannot cut a hole in a table-level grant, and `authenticated` holds
-- SELECT on the whole table. The table grant has to go first, and then every
-- column except this one is granted back — the same shape as the balance
-- column on `accounts`.
do $$
declare
  cols text;
begin
  if to_regclass('public.verification_requests') is null then
    raise notice 'verification_requests missing, skipping the ssn grant';
    return;
  end if;

  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'verification_requests'
     and column_name <> 'ssn';

  revoke select on public.verification_requests from authenticated, anon;
  execute format('grant select (%s) on public.verification_requests to authenticated', cols);
  raise notice 'verification_requests: ssn is write-only for customer sessions';
end $$;


-- ---------------------------------------------------------------------------
-- The bucket. PRIVATE — `public => false` is the difference between a
-- government ID that only its owner and the bank can fetch, and one anybody
-- with the URL can.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('kyc-documents', 'kyc-documents', false)
on conflict (id) do update set public = false;

-- Storage is an ordinary table with RLS, so the rules are ordinary policies.
-- Each one is scoped to the first folder of the path, which the client sets to
-- the uploader's own user id.
--
-- INSERT AND UPDATE BOTH, deliberately: the client uploads with `upsert: true`,
-- and an upsert against an existing object is an UPDATE. With only the insert
-- policy, a customer who retakes a blurred photo is refused — which is exactly
-- the moment they are most likely to try again.
--
-- No DELETE policy, equally deliberately. A submitted identity document is a
-- record of what the bank was given; it is not a customer's to remove.
drop policy if exists "own kyc documents read"   on storage.objects;
drop policy if exists "own kyc documents insert" on storage.objects;
drop policy if exists "own kyc documents update" on storage.objects;

create policy "own kyc documents read"
  on storage.objects for select to authenticated
  using (bucket_id = 'kyc-documents' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "own kyc documents insert"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'kyc-documents' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "own kyc documents update"
  on storage.objects for update to authenticated
  using (bucket_id = 'kyc-documents' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'kyc-documents' and (storage.foldername(name))[1] = auth.uid()::text);


-- =============================================================================
-- 11. STATEMENT FILES — THE BUCKET AND THE COLUMNS THAT POINT AT IT
--
-- THE ONE THAT MAKES "DOWNLOAD PDF" HAND OVER A FILE.
--
-- A statement row records what a statement SAYS — the period, the account, the
-- closing balance. It never recorded where the document IS, so there was
-- nothing for the download button to fetch and the app could only ever draw the
-- customer a summary of the row it already had.
--
-- These columns are that missing pointer, and the bucket below is what they
-- point into. Both are optional by design: a row with no path still downloads,
-- as a summary generated in the browser from the row itself (see
-- js/shared/documents.js). Filling the path in upgrades that row from a summary
-- to the bank's own document, one row at a time, with no change to the app.
--
-- The upsert pattern for whatever generates them: write the PDF to
--   statements/<user-id>/<period>-<doc-type>.pdf
-- then update the row for that user + period + type, or insert it if it is not
-- there yet. The path carries the user id as its FIRST folder, because that is
-- what the storage policies below check — a path shaped any other way is a file
-- its owner cannot read.
-- =============================================================================

do $$
begin
  if to_regclass('public.investment_statements') is null then
    raise notice 'investment_statements missing, skipping the storage columns';
  else
    alter table public.investment_statements
      -- Where the file lives, relative to the bucket. Null means "not generated
      -- yet", which the app reads as "draw the summary instead".
      add column if not exists storage_object_path text,
      -- Which bucket, for the day statements and tax forms live in different
      -- ones. Defaulted so nothing has to say it today.
      add column if not exists storage_bucket      text not null default 'statements',
      -- What the file should be CALLED when it lands in somebody's Downloads
      -- folder. Without this a customer ends up with a file named after a
      -- storage key.
      add column if not exists file_name           text,
      add column if not exists mime_type           text not null default 'application/pdf',
      add column if not exists file_size_bytes     bigint,
      add column if not exists file_generated_at   timestamptz;
  end if;

  -- The account documents hub downloads the same way and needs the same
  -- pointer. Same shape, deliberately: one download path serves both screens.
  if to_regclass('public.account_documents') is null then
    raise notice 'account_documents missing, skipping the storage columns';
  else
    alter table public.account_documents
      add column if not exists storage_object_path text,
      add column if not exists storage_bucket      text not null default 'statements',
      add column if not exists file_name           text,
      add column if not exists mime_type           text not null default 'application/pdf',
      add column if not exists file_size_bytes     bigint,
      add column if not exists file_generated_at   timestamptz;
  end if;
end $$;

-- One statement per customer, per period, per type. This is what makes the
-- generator's upsert an upsert rather than a way to accumulate four copies of
-- August: without it, "regenerate this month" appends, and the customer's list
-- fills with duplicates that all say the same thing.
--
-- Added only if the existing rows allow it. A table that already holds
-- duplicates would fail the whole script here, which is a worse outcome than
-- going without the constraint until somebody has looked at those rows.
do $$
begin
  if to_regclass('public.investment_statements') is null then
    return;
  end if;

  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.investment_statements'::regclass
       and conname = 'investment_statements_period_unique'
  ) then
    return;
  end if;

  if exists (
    select 1 from public.investment_statements
     group by user_id, statement_period, doc_type
    having count(*) > 1
  ) then
    raise warning 'investment_statements holds duplicate period/type rows — unique constraint NOT added, dedupe them first';
    return;
  end if;

  alter table public.investment_statements
    add constraint investment_statements_period_unique
    unique (user_id, statement_period, doc_type);
end $$;

-- ---------------------------------------------------------------------------
-- The bucket. PRIVATE, for the same reason the identity one is: a bank
-- statement carries a name, an address, an account number and a balance. A
-- public bucket would put every one of them behind a guessable URL.
--
-- Nothing is fetched from here directly. The app asks Storage for a signed URL
-- — this customer, this object, ten minutes — and downloads that, which is the
-- only way to read a private object from a browser.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('statements', 'statements', false)
on conflict (id) do update set public = false;

-- Read only, and only your own. The first folder of the path is the owner.
--
-- No insert, update or delete policy, and that is the point: statements are
-- written by the bank with the service key, never by a customer session. A
-- customer who could write into this bucket could write their own statement.
drop policy if exists "own statements read" on storage.objects;

create policy "own statements read"
  on storage.objects for select to authenticated
  using (bucket_id = 'statements' and (storage.foldername(name))[1] = auth.uid()::text);


-- =============================================================================
-- 12. OFFER CODES — THE ONE THAT MAKES SIGN-UP INVITE-ONLY
--
-- Nobody opens an account without a seven-digit offer code.
--
-- The sign-up form asks for one and checks it before it will move past the
-- step, but a form is a courtesy, not a gate: the field is editable, the
-- validator is JavaScript, and `auth.signUp` is a public endpoint anybody can
-- POST to with the anon key. The gate is the trigger at the bottom of this
-- section, on `auth.users` itself. Nothing reaches the user table without a
-- code that could be spent.
--
-- BEFORE INSERT, and consumed in the same transaction as the user row. That
-- ordering is the whole design:
--
--   * The trigger raises  -> the INSERT never happens -> no auth user, no
--     profile, no accounts, and the code is untouched.
--   * The trigger passes  -> the increment and the user row commit together.
--     If anything later in that transaction fails, both roll back.
--
-- The alternative — consume the code from the client, then create the user —
-- burns a code every time a sign-up fails after the check, and hands the
-- decision to the browser. This cannot do either.
-- =============================================================================

-- The codes themselves. Keyed on `code`, deliberately: this section never
-- refers to the primary key, so it does not matter whether an existing
-- offer_codes table has a uuid id, a bigint id, or no surrogate key at all.
create table if not exists public.offer_codes (
  code       text primary key,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- A table that was already here, brought into the shape the rest of this
-- section needs. Two things get fixed, and both of them are things a project
-- that rolled its own offer codes is likely to have.
--
-- 1. `code` STORED AS A NUMBER.
--
--    It is the obvious choice — the codes are digits — and it is wrong, because
--    a seven-digit code is not a quantity, it is a string that happens to be
--    made of digits. Stored as an integer, 0123456 is 123456: the leading zero
--    is not hidden, it is gone, and one code in ten is silently a six-digit
--    code that will never match what its owner types. Nothing else in this
--    section works against a number either — you cannot regex-match one, and
--    comparing it to the text the browser sends is an error rather than a
--    mismatch.
--
--    Converted in place with a plain cast, which changes no value. If that
--    leaves anything shorter than seven digits, the constraint below refuses to
--    be added and names the rows: those are the codes the leading zeros were
--    already lost from, and only whoever issued them knows what they were.
--
-- 2. `code` NOT UNIQUE.
--
--    Everything below keys on it. A campaign-plus-code model lets the same
--    seven digits exist twice, and then spending it updates both rows.
-- ---------------------------------------------------------------------------
do $$
declare
  coltype text;
begin
  select data_type into coltype
    from information_schema.columns
   where table_schema = 'public' and table_name = 'offer_codes' and column_name = 'code';

  if coltype is null then
    -- No `code` column at all. The ALTER below adds it.
    null;
  elsif coltype <> 'text' then
    execute 'alter table public.offer_codes alter column code type text using code::text';
    raise notice 'offer_codes.code converted from % to text — check for codes that lost a leading zero', coltype;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.offer_codes'::regclass
       and contype in ('p', 'u')
       and pg_get_constraintdef(oid) like '%(code)'
  ) then
    if exists (select code from public.offer_codes group by code having count(*) > 1) then
      raise warning 'offer_codes holds the same code more than once — uniqueness NOT enforced, and spending one of them will spend all of them';
    else
      alter table public.offer_codes add constraint offer_codes_code_key unique (code);
      raise notice 'offer_codes.code is now unique';
    end if;
  end if;
end $$;

alter table public.offer_codes
  add column if not exists code       text,
  -- What this code is for, for whoever reads the table later: 'launch-2026',
  -- 'branch-referral'. Never shown to an applicant.
  add column if not exists label      text,
  -- Null means unlimited. A number means that many sign-ups, total.
  add column if not exists max_uses   integer,
  add column if not exists used_count integer not null default 0,
  add column if not exists active     boolean not null default true,
  add column if not exists expires_at timestamptz,
  add column if not exists created_at timestamptz not null default now();

-- Seven digits, exactly. Enforced here as well as in the form, because the form
-- is not what decides what a valid code looks like.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.offer_codes'::regclass and conname = 'offer_codes_seven_digits'
  ) then
    if exists (select 1 from public.offer_codes where code !~ '^[0-9]{7}$') then
      raise warning 'offer_codes holds codes that are not seven digits — format constraint NOT added, fix those rows first';
    else
      alter table public.offer_codes
        add constraint offer_codes_seven_digits check (code ~ '^[0-9]{7}$');
    end if;
  end if;
end $$;

-- Who spent what. The bank's record of how an account was opened — `used_count`
-- is a tally and answers "how many left"; this answers "who, and when".
create table if not exists public.offer_code_redemptions (
  user_id     uuid primary key,
  code        text not null,
  redeemed_at timestamptz not null default now()
);

-- The foreign key is added separately and DEFERRABLE INITIALLY DEFERRED, and
-- both halves of that are load bearing.
--
-- The row is written from a BEFORE INSERT trigger on auth.users, so at the
-- moment it is written the user it refers to does not exist yet — the insert
-- that creates them has not run. An ordinary foreign key is checked at
-- statement time and rejects it, which fails the trigger, which fails the
-- sign-up: every valid code would be refused. Deferring the check to COMMIT
-- moves it to a point where the user row is there, and keeps both the integrity
-- and the ON DELETE CASCADE that an FK is worth having for.
--
-- Added rather than inlined so a table left behind by an earlier run gets the
-- same treatment as a new one.
do $$
begin
  alter table public.offer_code_redemptions
    drop constraint if exists offer_code_redemptions_user_id_fkey;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.offer_code_redemptions'::regclass
       and conname = 'offer_code_redemptions_user_fk'
  ) then
    alter table public.offer_code_redemptions
      add constraint offer_code_redemptions_user_fk
      foreign key (user_id) references auth.users (id) on delete cascade
      deferrable initially deferred;
  end if;
end $$;

create index if not exists offer_code_redemptions_code_idx
  on public.offer_code_redemptions (code, redeemed_at desc);

-- Both tables are the bank's, not the customer's. RLS on with no policy at all
-- is a deliberate deny-all: every read below goes through a security-definer
-- function instead, so a session holding the anon key can ask whether one code
-- works and cannot list, count or alter any of them.
alter table public.offer_codes            enable row level security;
alter table public.offer_code_redemptions enable row level security;
revoke all on public.offer_codes            from anon, authenticated;
revoke all on public.offer_code_redemptions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Is this code usable? The one question a stranger is allowed to ask.
--
-- 'ok' or 'invalid', and nothing else — NOT 'expired', NOT 'already used up'.
-- A code is seven digits, so the whole space is ten million; an answer that
-- distinguishes "no such code" from "that code is spent" turns this into an
-- oracle that confirms which of those ten million are real. One word costs the
-- applicant a slightly vaguer message and costs an enumerator everything.
--
-- It does not consume anything. It exists so the form can say "check that
-- code" at the step rather than at the end of the application, and it is not
-- what enforces the rule — the trigger below is.
-- ---------------------------------------------------------------------------
create or replace function public.offer_code_status(p_code text)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select case when exists (
    select 1 from public.offer_codes oc
     where oc.code = p_code
       and oc.active
       and (oc.max_uses   is null or oc.used_count < oc.max_uses)
       and (oc.expires_at is null or oc.expires_at > now())
  ) then 'ok' else 'invalid' end;
$$;

grant execute on function public.offer_code_status(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Spend one. Returns true if it was spent, false if it could not be.
--
-- The guard is the UPDATE's own WHERE clause, which is what makes this safe
-- under concurrency: two applications racing for the last use of a code both
-- try to update the same row, Postgres serialises them on the row lock, and the
-- second one re-evaluates `used_count < max_uses` against the first one's
-- committed value and matches nothing. A read-then-write would let both
-- through.
--
-- Not callable by a session. It is invoked by the trigger, with definer rights,
-- and a customer who could call it directly could spend other people's codes.
-- ---------------------------------------------------------------------------
create or replace function public.consume_offer_code(p_code text, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  spent boolean := false;
begin
  update public.offer_codes oc
     set used_count = oc.used_count + 1
   where oc.code = p_code
     and oc.active
     and (oc.max_uses   is null or oc.used_count < oc.max_uses)
     and (oc.expires_at is null or oc.expires_at > now())
  returning true into spent;

  if not coalesce(spent, false) then
    return false;
  end if;

  insert into public.offer_code_redemptions (user_id, code)
  values (p_user_id, p_code)
  on conflict (user_id) do update set code = excluded.code, redeemed_at = now();

  return true;
end;
$$;

revoke all on function public.consume_offer_code(text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The gate.
--
-- BEFORE INSERT on auth.users. It reads the code off the metadata the sign-up
-- form sends and spends it, and if it cannot, it refuses the insert — which
-- GoTrue reports to the browser as a failed sign-up and which leaves no user
-- behind.
--
-- The switch is in bank_settings so an operator can turn the requirement off
-- without dropping the trigger, and so creating a user by hand in the Supabase
-- dashboard is possible: flip it, add the user, flip it back. It defaults to
-- ON, because a gate that defaults to open is not a gate.
-- ---------------------------------------------------------------------------
alter table public.bank_settings
  add column if not exists offer_code_required boolean not null default true;

create or replace function public.require_offer_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  required boolean;
  code     text;
begin
  select coalesce(bs.offer_code_required, true) into required
    from public.bank_settings bs where bs.id = 1;

  -- No settings row is not permission to skip the check. An absent row means
  -- the reference data has not been loaded, and the safe reading of that is
  -- "the bank has not said this is open".
  if not coalesce(required, true) then
    return new;
  end if;

  code := nullif(trim(coalesce(new.raw_user_meta_data->>'offer_code', '')), '');

  if code is null or code !~ '^[0-9]{7}$' then
    raise exception 'offer code required'
      using errcode = 'check_violation',
            hint    = 'Sign-up needs a valid seven-digit offer code.';
  end if;

  if not public.consume_offer_code(code, new.id) then
    raise exception 'offer code not usable'
      using errcode = 'check_violation',
            hint    = 'That offer code does not exist, has expired, or has been fully used.';
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_offer_code on auth.users;
create trigger on_auth_user_offer_code
  before insert on auth.users
  for each row execute function public.require_offer_code();

-- A gate with no keys is a closed bank. This does not invent one — a code
-- committed to a source file is a code everybody has, which is the opposite of
-- what this section is for — but it will not let the situation pass quietly
-- either.
do $$
declare
  usable integer;
begin
  select count(*) into usable
    from public.offer_codes oc
   where oc.active
     and (oc.max_uses   is null or oc.used_count < oc.max_uses)
     and (oc.expires_at is null or oc.expires_at > now());

  if usable = 0 and coalesce((select offer_code_required from public.bank_settings where id = 1), true) then
    raise warning 'OFFER CODES: the requirement is ON and there are no usable codes — NOBODY CAN SIGN UP. Issue one, e.g. insert into public.offer_codes (code, label, max_uses) values (''1234567'', ''launch-2026'', 500);';
  else
    raise notice 'offer codes: % usable', usable;
  end if;
end $$;


-- =============================================================================
-- 13. VERIFICATION
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

-- The balance column must not be client-writable, whatever the policies say —
-- on an existing row or on a brand-new one. Ownership goes with them: a
-- customer who can write it can open their own joint account.
union all
select 'column grant', 'accounts.balance not writable by customers',
       case when has_column_privilege('authenticated', 'public.accounts', 'balance', 'UPDATE')
            then 'EXPOSED — customers can set their own balance' else 'ok' end

union all
select 'column grant', 'accounts.balance not settable at insert',
       case when has_column_privilege('authenticated', 'public.accounts', 'balance', 'INSERT')
            then 'EXPOSED — customers can open an account with any balance' else 'ok' end

union all
select 'column grant', 'accounts.ownership not settable by customers',
       case when has_column_privilege('authenticated', 'public.accounts', 'ownership', 'INSERT')
             or has_column_privilege('authenticated', 'public.accounts', 'ownership', 'UPDATE')
            then 'EXPOSED — customers can declare their own account joint' else 'ok' end

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
  from unnest(array['transactions','activity_events','accounts',
                    'notifications','deposit_requests']) as t

-- Without these, the Verify screen cannot upload and nobody can be verified.
union all
select 'identity uploads', 'verification_requests table',
       case when to_regclass('public.verification_requests') is not null
            then 'ok' else 'MISSING' end

union all
select 'identity uploads', 'kyc-documents bucket (private)',
       case when not exists (select 1 from storage.buckets where id = 'kyc-documents')
              then 'MISSING — ID upload will fail'
            when (select public from storage.buckets where id = 'kyc-documents')
              then 'EXPOSED — bucket is public, IDs readable by URL'
            else 'ok' end

union all
select 'identity uploads', 'storage policies (need insert + update)',
       case when (select count(*) from pg_policy
                   where polrelid = 'storage.objects'::regclass
                     and polname like 'own kyc documents%') >= 3
            then 'ok' else 'MISSING — retaking a photo will be refused' end

union all
select 'identity uploads', 'ssn not readable by customer sessions',
       case when has_column_privilege('authenticated', 'public.verification_requests', 'ssn', 'SELECT')
            then 'EXPOSED — a session can read SSNs back' else 'ok' end

-- Without these, Download PDF still works — it falls back to a summary drawn
-- in the browser — but the bank's own statement file can never be served.
union all
select 'statement files', 'statements bucket (private)',
       case when not exists (select 1 from storage.buckets where id = 'statements')
              then 'MISSING — stored statement PDFs cannot be served'
            when (select public from storage.buckets where id = 'statements')
              then 'EXPOSED — bucket is public, statements readable by URL'
            else 'ok' end

union all
select 'statement files', 'own statements read policy',
       case when exists (select 1 from pg_policy
                          where polrelid = 'storage.objects'::regclass
                            and polname = 'own statements read')
            then 'ok' else 'MISSING — a signed URL will be refused' end

union all
select 'statement files', 'investment_statements.storage_object_path',
       case when to_regclass('public.investment_statements') is null then 'table missing'
            when exists (select 1 from information_schema.columns
                          where table_schema = 'public' and table_name = 'investment_statements'
                            and column_name = 'storage_object_path')
            then 'ok' else 'MISSING — every download will be a generated summary' end

-- The invite-only gate. Read all four together: the trigger is what enforces
-- it, and a requirement switched on with no usable codes behind it is a bank
-- nobody can open an account at.
union all
select 'offer codes', 'offer_codes table',
       case when to_regclass('public.offer_codes') is not null then 'ok' else 'MISSING' end

union all
select 'offer codes', 'sign-up gate trigger',
       case when exists (select 1 from pg_trigger where tgname = 'on_auth_user_offer_code'
                           and tgrelid = 'auth.users'::regclass)
            then 'ok' else 'MISSING — anyone can sign up without a code' end

union all
select 'offer codes', 'requirement switched on',
       case when coalesce((select offer_code_required from public.bank_settings where id = 1), true)
            then 'ok' else 'OFF — bank_settings.offer_code_required is false' end

union all
select 'offer codes', 'usable codes available',
       case when to_regclass('public.offer_codes') is null then 'table missing'
            when not coalesce((select offer_code_required from public.bank_settings where id = 1), true)
              then 'n/a — requirement is off'
            when exists (select 1 from public.offer_codes
                          where active
                            and (max_uses   is null or used_count < max_uses)
                            and (expires_at is null or expires_at > now()))
            then 'ok' else 'NONE — nobody can sign up; issue a code' end

union all
select 'offer codes', 'codes not readable by customer sessions',
       case when has_table_privilege('anon', 'public.offer_codes', 'SELECT')
             or has_table_privilege('authenticated', 'public.offer_codes', 'SELECT')
            then 'EXPOSED — a session can list every code' else 'ok' end

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
-- 14. OPTIONAL — pg_cron
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
