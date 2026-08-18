-- What the support path already has, from inside the database.
--
-- Paste the whole file into the Supabase SQL editor and run it. It reads and
-- reports; it creates nothing, changes nothing, and is safe to run on a live
-- project as often as you like.
--
-- It answers the database half — the two tables, RLS, the policies, the
-- trigger, and what traffic has actually gone through them. It cannot see the
-- functions or the mailbox: an edge function's secrets are not in Postgres,
-- and whether support@verceilbank.com accepted a login is not a question SQL
-- can ask. `node scripts/check-support-mail.js` covers that half, and the two
-- together cover the path end to end.
--
-- One caveat the report cannot state about itself: a message can fail with
-- "Could not find the table" while every row below says ok. That is PostgREST
-- answering from a stale picture of the schema, not the database disagreeing.
-- The cure is `notify pgrst, 'reload schema';` — see docs/supabase-setup.md 5i.

-- Created in pg_temp, so it belongs to this session only and disappears when
-- the tab closes. Nothing is added to the schema. It is a function rather than
-- a plain query because the row counts have to be read from tables that may
-- not exist, and a direct `select ... from support_threads` against a missing
-- table fails at parse time — taking the report that was meant to tell you it
-- is missing down with it.
create or replace function pg_temp.support_status()
returns table (part text, status text, detail text)
language plpgsql
as $report$
declare
  threads   regclass := to_regclass('public.support_threads');
  messages  regclass := to_regclass('public.support_messages');
  flag      boolean;
  n         bigint;
  m         bigint;
  seen      timestamptz;
  txt       text;
begin
  -- ---- the two tables -------------------------------------------------------
  part := 'table support_threads';
  if threads is null then
    status := 'missing'; detail := 'not created — run supabase/setup.sql section 1';
  else
    status := 'ok'; detail := 'exists';
  end if;
  return next;

  part := 'table support_messages';
  if messages is null then
    status := 'missing'; detail := 'not created — run supabase/setup.sql section 1';
  else
    status := 'ok'; detail := 'exists';
  end if;
  return next;

  -- ---- row level security ---------------------------------------------------
  -- Without RLS on, the anon key in every visitor's browser reads every
  -- customer's messages to their bank. This is the row to look at first.
  if threads is not null then
    select relrowsecurity into flag from pg_class where oid = threads;
    part := 'RLS on support_threads';
    if flag then status := 'ok'; detail := 'enabled';
    else status := 'missing'; detail := 'OFF — every customer''s threads are readable with the anon key. Run section 4'; end if;
    return next;

    select count(*) into n from pg_policies
     where schemaname = 'public' and tablename = 'support_threads';
    part := 'policies on support_threads';
    if n > 0 then status := 'ok'; detail := n || ' attached';
    else status := 'missing'; detail := 'none — with RLS on and no policy, a customer cannot open a thread at all'; end if;
    return next;
  end if;

  if messages is not null then
    select relrowsecurity into flag from pg_class where oid = messages;
    part := 'RLS on support_messages';
    if flag then status := 'ok'; detail := 'enabled';
    else status := 'missing'; detail := 'OFF — every customer''s messages are readable with the anon key. Run section 4'; end if;
    return next;

    select count(*) into n from pg_policies
     where schemaname = 'public' and tablename = 'support_messages';
    part := 'policies on support_messages';
    if n > 0 then status := 'ok'; detail := n || ' attached';
    else status := 'missing'; detail := 'none — a send comes back 42501, insufficient_privilege'; end if;
    return next;
  end if;

  -- ---- the pieces that keep the thread list honest --------------------------
  if messages is not null then
    -- Without it a reply lands in the database and the thread stays 'open' with
    -- yesterday's timestamp: no unread dot, no count on the tab, and it sorts
    -- to the bottom of the list where nobody looks.
    select count(*) into n from pg_trigger
     where tgrelid = messages and tgname = 'support_messages_touch_thread' and not tgisinternal;
    part := 'trigger touch_support_thread';
    if n > 0 then status := 'ok'; detail := 'a new message bumps its thread';
    else status := 'missing'; detail := 'threads will not move to answered or re-sort when a reply arrives'; end if;
    return next;

    select count(*) into n from pg_constraint
     where conrelid = messages and confrelid = threads and contype = 'f';
    part := 'messages → threads FK';
    if n > 0 then status := 'ok'; detail := 'a message cannot exist without its thread';
    else status := 'missing'; detail := 'orphan messages are possible'; end if;
    return next;
  end if;

  -- The words these two columns accept, against the words the code writes.
  -- A constraint that forbids one of them does not fail loudly: the app keys
  -- its unread dot on status = 'answered', so a schema without that value
  -- simply never shows one, and support-inbound writes sender = 'support', so
  -- a schema without that value refuses every arriving email. Both look like
  -- nothing happening rather than like an error.
  if threads is not null then
    select pg_get_constraintdef(oid) into txt from pg_constraint
     where conrelid = threads and contype = 'c' and conname like '%status%';
    part := 'status accepts answered';
    if txt is null then
      status := 'info'; detail := 'no check constraint on status — nothing to forbid it';
    elsif position('answered' in txt) > 0 then
      status := 'ok'; detail := 'the unread dot and the tab count can work';
    else
      status := 'missing';
      detail := 'status is limited to ' || txt
                || ' — the app keys its unread dot on answered, so a reply will never be flagged, '
                || 'and the touch_support_thread trigger cannot write it';
    end if;
    return next;
  end if;

  if messages is not null then
    select pg_get_constraintdef(oid) into txt from pg_constraint
     where conrelid = messages and contype = 'c' and conname like '%sender%';
    part := 'sender accepts support';
    if txt is null then
      status := 'info'; detail := 'no check constraint on sender — nothing to forbid it';
    elsif position('support' in txt) > 0 then
      status := 'ok'; detail := 'the bank can write a reply, and support-inbound can too';
    else
      status := 'missing';
      detail := 'sender is limited to ' || txt
                || ' — support-inbound writes ''support'' and would be refused. The app itself is '
                || 'indifferent: it renders anything that is not ''user'' as the bank';
    end if;
    return next;
  end if;

  part := 'indexes';
  select count(*) into n from pg_indexes
   where schemaname = 'public'
     and indexname in ('support_threads_user_updated_idx', 'support_messages_thread_created_idx');
  if n = 2 then status := 'ok'; detail := 'both present';
  else status := 'info'; detail := n || ' of 2 — the screen still works, it just scans more'; end if;
  return next;

  -- ---- what has actually gone through ---------------------------------------
  -- Structure that is correct and never used looks exactly like structure that
  -- is correct and working. These rows tell the two apart.
  if threads is not null then
    execute 'select count(*), max(updated_at) from public.support_threads' into n, seen;
    part := 'threads';
    status := 'info';
    if n = 0 then detail := 'none yet — nobody has sent a message from the app';
    else
      execute 'select count(*) from public.support_threads where status = ''open''' into m;
      detail := n || ' total, ' || m || ' open, last activity ' || coalesce(seen::text, 'unknown');
    end if;
    return next;
  end if;

  if messages is not null then
    -- Anything that is not the customer is the bank. Which word a schema uses
    -- for that — 'support', 'agent' — is not something this should assume: the
    -- first version of this file counted sender = 'support' and would have
    -- reported a schema that says 'agent' as having no replies at all, on a
    -- day when the whole question was whether replies were getting through.
    execute 'select count(*) from public.support_messages where sender = ''user''' into n;
    execute 'select count(*), max(created_at) from public.support_messages where sender <> ''user''' into m, seen;
    part := 'messages';
    status := 'info';
    detail := n || ' from customers, ' || m || ' from the bank'
              || case when m > 0 then ', last reply ' || seen::text
                      when n > 0 then ' — nothing has been answered yet'
                      else '' end;
    return next;

    -- The app writes the thread, then the first message, and cannot make the
    -- two one operation from the browser. So a message insert that is refused
    -- — RLS, usually, coming back as 42501 — leaves the thread behind with
    -- nothing in it. The customer saw an error and their text still in the box;
    -- what is left here is the count of times that happened. It is the one
    -- number in this report that means a customer tried and did not get through.
    -- Threads written in the last two minutes are left out: on a live project
    -- one of them may be a send still in flight, its message a moment behind
    -- its thread, and counting that as a failure would report a fault that
    -- resolves itself while you are reading about it.
    execute $q$
      select count(*), min(created_at) from public.support_threads t
       where t.created_at < now() - interval '2 minutes'
         and not exists (select 1 from public.support_messages m where m.thread_id = t.id)
    $q$ into n, seen;
    if n > 0 then
      part := 'threads holding no message';
      status := 'info';
      detail := n || ' — each one is a send whose message was refused after the '
                || 'thread was written, oldest ' || seen::text
                || '. Check the policies on support_messages, and whether the '
                || 'dates cluster: a cluster that stopped is a fault already fixed';
      return next;
    end if;

    -- A message written from the app and never emailed leaves no trace here,
    -- so the oldest unanswered one is the closest thing the database has to
    -- "mail is not arriving". It is a prompt to check, not a fault.
    execute $q$
      select count(*), min(t.created_at)
        from public.support_threads t
       where t.status = 'open'
         and not exists (select 1 from public.support_messages m
                          where m.thread_id = t.id and m.sender <> 'user')
    $q$ into n, seen;
    if n > 0 then
      part := 'waiting on the bank';
      status := 'info';
      detail := n || ' thread(s) with no reply, oldest ' || seen::text
                || ' — if that is a surprise, the mail is not reaching the inbox: '
                || 'check with node scripts/check-support-mail.js --verify';
      return next;
    end if;
  end if;

  -- ---- the half this cannot see ---------------------------------------------
  part := 'support-notify / mailbox';
  status := 'info';
  detail := 'not visible from SQL — run: node scripts/check-support-mail.js';
  return next;
end
$report$;

select * from pg_temp.support_status();
