// Emails the support inbox whenever someone sends a message from the app.
//
// This runs server-side for one reason: the mailbox password must never reach
// the browser. Everything under js/ is downloaded by the client, so a password
// placed there would be readable by anyone who opens devtools — and that
// password can read support@ as well as send from it.
//
// The app calls this after the message row is already written, and never waits
// on the result — the message is saved either way, so a mail outage must not
// look to the user like a failed send.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { readSmtpSettings, sendMail, verifySmtp, type SendResult } from '../_shared/mailer.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const CATEGORY_LABELS: Record<string, string> = {
  general: 'General',
  card_application: 'Card application',
  funding_zelle: 'Funding — Zelle',
  funding_cashapp: 'Funding — Cash App',
  funding_paypal: 'Funding — PayPal',
  funding_ach: 'Funding — ACH transfer',
  disputes: 'Disputes',
  account_access: 'Account access',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// The thread id rides in the Reply-To address as a plus tag, so a plain reply
// from any mail client comes back knowing which conversation it belongs to.
// Nothing is asked of whoever answers — they just hit reply.
function replyToAddress(inbound: string, threadId: string) {
  const at = inbound.lastIndexOf('@');
  if (at < 0) return inbound;
  const local = inbound.slice(0, at);
  const domain = inbound.slice(at + 1);
  return `${local}+${threadId}@${domain}`;
}

// Reads the `role` claim out of a JWT without verifying it. This is only ever
// used to write a better error message — never to decide whether a caller is
// allowed in. That decision stays with getUser(), which checks the signature.
// An unverified claim is fine for "what did you probably mean to send"; it
// would be a hole for "may you do this".
function tokenRole(jwt: string) {
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return '';
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/')
      .padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=');
    return String(JSON.parse(atob(padded))?.role ?? '');
  } catch {
    return '';
  }
}

// Compared without an early exit, so the response time does not leak how much
// of the key was right.
function secretMatches(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST' && req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
  // The bank's own address. Where the mail goes is not confidential — it is on
  // the marketing site, in the footer, in the page's structured data and on the
  // Support screen itself — and leaving it to configuration meant the whole path
  // could be deployed, correct, and silently mailing nowhere because one more
  // variable was missed. It can still be overridden from the environment;
  // without one it is right rather than unset.
  //
  // The sender is not read here. A mailbox can only send as itself, so the
  // mailer derives it from the account that logs in — there is no address this
  // could be set to that the provider would accept.
  const SUPPORT_INBOX = Deno.env.get('SUPPORT_INBOX') || 'support@verceilbank.com';
  // Deliberately no fallback. Until a domain is set up to receive mail there is
  // no address a reply could come back through, and quietly falling back to the
  // inbox itself would put a Reply-To on the mail that just loops to the reader.
  // Unset means the email says how to answer instead of promising a reply works.
  const SUPPORT_INBOUND_ADDRESS = Deno.env.get('SUPPORT_INBOUND_ADDRESS');
  const inboundReady = !!SUPPORT_INBOUND_ADDRESS;

  // Which settings are absent, by name. A missing one is the most common
  // reason no mail arrives, and until now the only place that said so was the
  // function log — the caller got a flat "Email is not configured" and had to
  // go digging. The names of the settings are not sensitive; their values are,
  // and none of those are ever put in a response.
  const { settings, missing } = readSmtpSettings();
  if (!SUPPORT_INBOX) missing.push('SUPPORT_INBOX');

  // GET is a config check, so "is this deployed, and is it configured?" can be
  // answered by opening the URL — without sending a message to find out. It
  // reports only whether each setting is present, never what it is set to.
  //
  // ?verify=1 logs in to the mailbox, which is the only way to tell a wrong
  // password apart from a message that was accepted and then lost. ?test=1
  // goes all the way and posts a real email, because a login that succeeds
  // still does not prove delivery.
  //
  // The POST path cannot stand in for either of these. It reads the message
  // out of the database rather than taking it from the caller, so it needs a
  // thread and a message that already exist, and it needs the access token of
  // the customer who owns them — an anon key is not a signed-in user and is
  // turned away before any mail is attempted. That is the right behaviour for
  // the send path and a poor way to ask "does mail work at all", which is what
  // these two answer.
  if (req.method === 'GET') {
    const params = new URL(req.url).searchParams;
    const wantsTest = params.get('test') === '1';
    const wantsVerify = params.get('verify') === '1' || wantsTest;

    // A test send is gated on the service role key, and goes only ever to
    // SUPPORT_INBOX — the destination comes from config, never from the
    // request. Both halves matter: without the first, anyone who found the URL
    // could make the mailbox send on demand; without the second, this would be
    // an open relay pointed at whatever address a stranger passed in.
    if (wantsTest) {
      const supplied = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
      if (!SERVICE_KEY || !secretMatches(supplied, SERVICE_KEY)) {
        return json({ error: 'A test send needs the service role key' }, 401);
      }
    }

    const check = wantsVerify && settings ? await verifySmtp(settings) : null;

    let testSend: SendResult | null = null;
    if (wantsTest && settings && SUPPORT_INBOX && check?.ok) {
      testSend = await sendMail(settings, {
        to: SUPPORT_INBOX,
        subject: 'Verceil Bank — support mail test',
        html: '<p>If this arrived, support-notify can send mail.</p>',
        text: 'If this arrived, support-notify can send mail.',
      });
    }

    return json({
      function: 'support-notify',
      deployed: true,
      configured: missing.length === 0,
      missing,
      transport: settings ? `smtp://${settings.host}:${settings.port}` : null,
      inbound_replies_enabled: inboundReady,
      ...(check
        ? check.ok
          ? { smtp_login: 'ok' }
          : { smtp_login: 'failed', smtp_code: check.code, smtp_message: check.message }
        : {}),
      ...(testSend
        ? testSend.ok
          ? { test_send: 'accepted', test_send_to: SUPPORT_INBOX }
          : { test_send: 'failed', smtp_code: testSend.code, smtp_message: testSend.message }
        : {}),
    });
  }

  if (!settings || missing.length > 0) {
    console.error('support-notify is missing:', missing.join(', '));
    return json({ error: 'Email is not configured', missing }, 500);  }

  try {
    const { thread_id, message_id } = await req.json();
    if (!thread_id || !message_id) return json({ error: 'thread_id and message_id are required' }, 400);

    // Who is asking. The caller's own token is checked before anything is read,
    // so this cannot be used to pull someone else's conversation into an email.
    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    if (!jwt) return json({ error: 'Not signed in' }, 401);

    const anon = createClient(SUPABASE_URL, ANON_KEY);
    const { data: userData, error: userError } = await anon.auth.getUser(jwt);
    if (userError || !userData?.user) {
      // A project key is the thing people reach for first, and both of them
      // land here looking exactly like an expired token. They are not weaker
      // credentials than a customer's — they are not a customer at all, which
      // is what this asks for, so saying "not signed in" sends the reader off
      // to check their session instead of their header.
      const role = tokenRole(jwt);
      if (role === 'anon' || role === 'service_role') {
        return json({
          error: `That is the ${role} key, not a signed-in customer's access token`,
          detail: 'This endpoint emails one customer\'s own message, so it needs that customer. A project key is not a user and has no thread to send.',
          hint: 'To check mail instead, GET this URL with ?test=1 and the service role key.',
        }, 401);
      }
      return json({ error: 'Not signed in' }, 401);
    }
    const user = userData.user;

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: thread, error: threadError } = await admin
      .from('support_threads')
      .select('*')
      .eq('id', thread_id)
      .maybeSingle();
    if (threadError) throw threadError;
    if (!thread) return json({ error: 'Thread not found' }, 404);
    if (thread.user_id !== user.id) return json({ error: 'Not your thread' }, 403);

    const { data: message, error: messageError } = await admin
      .from('support_messages')
      .select('*')
      .eq('id', message_id)
      .maybeSingle();
    if (messageError) throw messageError;
    if (!message || String(message.thread_id) !== String(thread_id)) {
      return json({ error: 'Message not found on that thread' }, 404);
    }

    const category = CATEGORY_LABELS[thread.category] ?? thread.category ?? 'General';
    const replyTo = inboundReady ? replyToAddress(String(SUPPORT_INBOUND_ADDRESS), String(thread.id)) : '';

    // What the footer promises has to match what is actually wired up.
    const howToAnswer = inboundReady
      ? "Reply to this email and your answer appears in the customer's app."
      : 'Replies by email are not enabled yet. Answer from the Supabase dashboard using the thread id above.';

    // The subject tag is a fallback: if a mail client ever drops the Reply-To,
    // the inbound side can still find the thread from the subject line.
    const subject = `[VB-${thread.id}] ${thread.subject || 'Support request'}`;

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#111827;font-size:14px;line-height:1.55">
        <p style="margin:0 0 16px"><strong>${escapeHtml(thread.subject || 'Support request')}</strong></p>
        <p style="margin:0 0 16px;white-space:pre-wrap">${escapeHtml(message.body)}</p>
        <hr style="border:0;border-top:1px solid #E5E7EB;margin:20px 0">
        <p style="margin:0;color:#6B7280;font-size:12px">
          Category: ${escapeHtml(category)}<br>
          From: ${escapeHtml(user.email ?? 'unknown')}<br>
          Thread: ${escapeHtml(thread.id)}
        </p>
        <p style="margin:16px 0 0;color:#6B7280;font-size:12px">
          ${escapeHtml(howToAnswer)}
        </p>
      </div>
    `;

    const text = [
      thread.subject || 'Support request',
      '',
      message.body,
      '',
      '---',
      `Category: ${category}`,
      `From: ${user.email ?? 'unknown'}`,
      `Thread: ${thread.id}`,
      '',
      howToAnswer,
    ].join('\n');

    const sent = await sendMail(settings, {
      to: SUPPORT_INBOX,
      subject,
      html,
      text,
      ...(replyTo ? { replyTo } : {}),
    });

    if (!sent.ok) {
      console.error('SMTP send failed:', sent.code, sent.message);
      // The server says why it refused — a rejected password, a From it will
      // not send as — and that sentence is the whole answer to "why is no mail
      // arriving". It describes the account's own mail setup, not the customer
      // or their message, so it is passed back rather than flattened into a
      // generic failure that leaves the reader guessing.
      return json({
        error: 'Could not send the notification email',
        smtp_code: sent.code,
        smtp_message: sent.message,
      }, 502);
    }

    return json({ ok: true });
  } catch (err) {
    console.error('support-notify error:', err);
    return json({ error: 'Unexpected error' }, 500);
  }
});
