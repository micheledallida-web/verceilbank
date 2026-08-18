#!/usr/bin/env node
// Reports which parts of the support-mail path are already there, and which
// are not.
//
// The path has four independent pieces — two tables, two functions, the
// mailbox login, and a delivered message — and each one fails in its own way.
// Chasing them by hand means a SQL query, two curls and a guess at what a 401
// meant, so a setup that is half-done tends to read as "nothing works". This
// asks each piece about itself and prints one list.
//
// Nothing here changes anything. The default run only reads; --verify logs in
// to the mailbox without sending, and --test posts one real email. Neither of
// the last two happens unless asked for.
//
//   node scripts/check-support-mail.js
//   node scripts/check-support-mail.js --verify
//   node scripts/check-support-mail.js --test     # needs the service role key
//
// The database half has a second opinion that does not depend on the network
// reaching this machine: supabase/check-support-mail.sql, pasted into the SQL
// editor, reports the tables, RLS, the policies and what traffic has gone
// through them. This half is the one SQL cannot see.
//
// Exit code is 0 when everything required is confirmed present, 1 when
// something is missing or could not be checked. Optional pieces — replying by
// email, which Namecheap cannot do — are reported but never fail the run.
'use strict';

const fs = require('fs');
const path = require('path');

const args = new Set(process.argv.slice(2));
const wantsVerify = args.has('--verify') || args.has('--test');
const wantsTest = args.has('--test');

if (args.has('--help') || args.has('-h')) {
  console.log(`Usage: node scripts/check-support-mail.js [--verify] [--test]

  (no flags)  read-only: tables, functions, which secrets are set
  --verify    also log in to the mailbox, sending nothing
  --test      also send one real email to SUPPORT_INBOX (service role key)

Reads SUPABASE_URL and SUPABASE_ANON_KEY from the environment, falling back to
js/config.js if it has been generated. --test additionally needs
SUPABASE_SERVICE_ROLE_KEY.`);
  process.exit(0);
}

// The anon key is public — it ships in every visitor's browser — so reading it
// out of the generated config is not a leak, it just saves exporting the same
// two values that `npm run build` already used. The service role key is never
// read from a file: it is not in one, and it should not be.
function fromGeneratedConfig(name) {
  try {
    const file = fs.readFileSync(path.join(__dirname, '..', 'js', 'config.js'), 'utf8');
    const found = file.match(new RegExp(`window\\.${name}\\s*=\\s*(['"])([^'"]+)\\1`));
    return found ? found[2] : '';
  } catch {
    return '';
  }
}

const SUPABASE_URL = (process.env.SUPABASE_URL || fromGeneratedConfig('SUPABASE_URL') || '').replace(/\/$/, '');
const ANON_KEY = process.env.SUPABASE_ANON_KEY || fromGeneratedConfig('SUPABASE_ANON_KEY') || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !ANON_KEY) {
  console.error(
    'Set SUPABASE_URL and SUPABASE_ANON_KEY, or run `npm run build` once so\n' +
    'js/config.js exists for this to read them from.'
  );
  process.exit(1);
}
if (wantsTest && !SERVICE_KEY) {
  console.error('--test sends a real email, which the function gates on SUPABASE_SERVICE_ROLE_KEY. Set it, or drop --test.');
  process.exit(1);
}

// Four outcomes, and the fourth is the one worth being strict about. A check
// that could not complete is not a pass: a proxy, a VPN or an offline laptop
// can refuse a request in a way that looks superficially like the database
// refusing it, and a report that reads that as "already set up" sends somebody
// looking for a problem that is not there — or worse, tells them RLS is on
// when nothing ever asked the database.
const YES = 'ok';
const NO = 'missing';
const NA = 'n/a';
const UNKNOWN = 'unknown';

// The mail server's sentence usually starts with the same number the code
// field carries — "535 Incorrect authentication data" — so printing both
// gives "535 535 …". Say it once.
function smtpReason(code, message) {
  const said = String(message ?? '').trim();
  if (code == null) return said || 'no reason given';
  return said.startsWith(String(code)) ? said : `${code} ${said}`.trim();
}

const results = [];
function record(status, what, detail, { required = true } = {}) {
  results.push({ status, what, detail, required });
}

// Anything that is not JSON did not come from PostgREST or from a function —
// both answer JSON, always, including when they refuse. HTML or plain text on
// the wire means something in between answered instead, and the body is worth
// keeping: it is usually the thing saying why.
async function ask(url, token, init = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY, ...(init.headers || {}) },
    });
  } catch (err) {
    return { reachable: false, why: err && err.message ? err.message : String(err) };
  }
  const text = await res.text();
  try {
    return { reachable: true, status: res.status, body: JSON.parse(text), json: true };
  } catch {
    return { reachable: true, status: res.status, body: null, json: false, text: text.trim().slice(0, 120) };
  }
}

function unreachable(what, reply, opts) {
  record(
    UNKNOWN,
    what,
    reply.reachable
      ? `could not tell: ${reply.status} from something in front of the API${reply.text ? ` — ${reply.text}` : ''}`
      : `could not tell: ${reply.why}`,
    opts
  );
}

// A table that is not there and a table whose rows RLS is refusing look the
// same from the app — both end a send with an error — but they are different
// repairs, and the Postgres code on the reply says which. Reading nothing back
// with the anon key is the expected, correct state: a stranger has no threads.
async function checkTable(name) {
  const reply = await ask(`${SUPABASE_URL}/rest/v1/${name}?select=id&limit=1`, ANON_KEY);
  const what = `table ${name}`;
  if (!reply.reachable || !reply.json) return unreachable(what, reply);

  const code = reply.body && reply.body.code;
  if (reply.status === 200) return record(YES, what, 'exists, API can see it');
  if (code === 'PGRST205') return record(NO, what, "not in the API schema cache — create it, or: notify pgrst, 'reload schema';");
  if (code === '42P01') return record(NO, what, 'does not exist — run supabase/setup.sql');
  if (code === '42501') return record(YES, what, 'exists; RLS is refusing anon, which is correct');
  if (reply.status === 401) return record(UNKNOWN, what, 'the anon key was rejected — check SUPABASE_ANON_KEY, then run this again');
  return record(NO, what, `unexpected reply ${reply.status}${code ? ` (${code})` : ''}`);
}

// support-notify answers GET about itself, so "is it deployed and configured"
// is one request and does not involve sending a message to find out.
async function checkNotify() {
  const url = new URL(`${SUPABASE_URL}/functions/v1/support-notify`);
  if (wantsVerify) url.searchParams.set('verify', '1');
  if (wantsTest) url.searchParams.set('test', '1');

  const reply = await ask(url.toString(), wantsTest ? SERVICE_KEY : ANON_KEY);
  const what = 'function support-notify';

  if (!reply.reachable || !reply.json) {
    unreachable(what, reply);
    return null;
  }
  if (reply.status === 404) {
    record(NO, what, 'not deployed — supabase functions deploy support-notify');
    return null;
  }

  const body = reply.body || {};
  record(YES, what, 'deployed');

  const missing = Array.isArray(body.missing) ? body.missing : [];
  if (body.configured) record(YES, 'mailbox secrets', `set; sending over ${body.transport}`);
  else record(NO, 'mailbox secrets', `not set: ${missing.join(', ') || 'unknown'} — supabase secrets set SMTP_USER=… SMTP_PASSWORD=…`);

  // Port 465 is the one that connects from the edge runtime. A send on 587
  // hangs and times out with nothing in the logs, which reads as a dead
  // function rather than a wrong port, so it is worth saying before it does.
  if (body.transport && !String(body.transport).endsWith(':465')) {
    record(NO, 'smtp port', `${body.transport} — the edge runtime is unreliable off 465; unset SMTP_PORT`);
  }

  if (body.smtp_login === 'ok') record(YES, 'mailbox login', 'the mailbox accepted the password');
  else if (body.smtp_login === 'failed') record(NO, 'mailbox login', smtpReason(body.smtp_code, body.smtp_message));
  else if (wantsVerify && body.configured) record(UNKNOWN, 'mailbox login', 'the function did not report a login result');

  if (body.test_send === 'accepted') record(YES, 'test send', `the server accepted a message to ${body.test_send_to}`);
  else if (body.test_send === 'failed') record(NO, 'test send', smtpReason(body.smtp_code, body.smtp_message));
  else if (wantsTest && body.smtp_login === 'ok') record(UNKNOWN, 'test send', 'the function did not report a send');

  record(
    body.inbound_replies_enabled ? YES : NA,
    'replies by email',
    body.inbound_replies_enabled
      ? 'SUPPORT_INBOUND_ADDRESS is set — a reply comes back into the app'
      : 'off. Correct on Namecheap: a mailbox cannot post arriving mail to a webhook. Answer threads from the dashboard',
    { required: false }
  );

  return body;
}

// Deployed, and is its shared secret set? Both are readable from a request
// that carries no token: the function turns it away either way, and which
// refusal it gives says which. Nothing is written by asking.
async function checkInbound(inboundEnabled) {
  const what = 'function support-inbound';
  // Only required once replying by email is actually in use; until then this
  // is reported for information and cannot fail the run.
  const opts = { required: !!inboundEnabled };
  const absent = inboundEnabled ? NO : NA;

  const reply = await ask(`${SUPABASE_URL}/functions/v1/support-inbound`, ANON_KEY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });

  if (!reply.reachable || !reply.json) return unreachable(what, reply, opts);
  if (reply.status === 404) return record(absent, what, 'not deployed', opts);
  if (reply.status === 401) return record(YES, what, 'deployed, SUPPORT_INBOUND_SECRET is set', opts);
  if (reply.status === 500) return record(absent, what, 'deployed, but SUPPORT_INBOUND_SECRET is not set', opts);
  return record(absent, what, `unexpected reply ${reply.status}`, opts);
}

(async () => {
  console.log(`Support mail — what is already there\n${SUPABASE_URL}\n`);

  await checkTable('support_threads');
  await checkTable('support_messages');
  const notify = await checkNotify();
  await checkInbound(notify && notify.inbound_replies_enabled);

  const mark = { [YES]: '✓', [NO]: '✗', [NA]: '–', [UNKNOWN]: '?' };
  const width = results.reduce((n, r) => Math.max(n, r.what.length), 0);
  for (const r of results) {
    console.log(`  ${mark[r.status]} ${r.what.padEnd(width)}  ${r.detail}`);
  }

  const broken = results.filter((r) => r.status === NO && r.required);
  const untold = results.filter((r) => r.status === UNKNOWN && r.required);
  const parts = [];
  if (broken.length) parts.push(`${broken.length} to fix`);
  if (untold.length) parts.push(`${untold.length} that could not be checked`);

  console.log('');
  if (parts.length === 0) {
    const sent = results.some((r) => r.what === 'test send' && r.status === YES);
    const loggedIn = results.some((r) => r.what === 'mailbox login' && r.status === YES);
    console.log(
      sent ? 'Everything required is in place, and a message reached the inbox.'
        : loggedIn ? 'Everything required is in place, and the mailbox accepted the login. Add --test to prove delivery.'
        : 'Everything required is in place. Add --verify to check the mailbox password, --test to send one.'
    );
    process.exit(0);
  }
  console.log(`${parts.join(', ')} — see docs/supabase-setup.md section 5i.`);
  if (untold.length) {
    console.log('A "?" is not a fault in the setup: nothing answered for it. Check the URL, the key, and whether this machine can reach the project.');
  }
  process.exit(1);
})().catch((err) => {
  console.error(`Could not finish the check: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
