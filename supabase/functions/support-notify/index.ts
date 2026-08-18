// Emails the support inbox whenever someone sends a message from the app.
//
// This runs server-side for one reason: the Resend API key must never reach the
// browser. Everything under js/ is downloaded by the client, so a key placed
// there would be readable by anyone who opens devtools.
//
// The app calls this after the message row is already written, and never waits
// on the result — the message is saved either way, so a mail outage must not
// look to the user like a failed send.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
  // The bank's own address, and the only secret genuinely worth being a secret
  // here is the API key. Where the mail goes is not confidential — it is on the
  // marketing site, in the footer, in the page's structured data and on the
  // Support screen itself — and leaving it to configuration meant the whole
  // path could be deployed, correct, and silently mailing nowhere because one
  // of three variables was missed. Either can still be overridden from the
  // environment; without one, it is right rather than unset.
  const SUPPORT_INBOX = Deno.env.get('SUPPORT_INBOX') || 'support@verceilbank.com';
  const SUPPORT_FROM = Deno.env.get('SUPPORT_FROM') || 'Verceil Bank <support@verceilbank.com>';
  // Deliberately no fallback. Until a domain is set up to receive mail there is
  // no address a reply could come back through, and quietly falling back to the
  // inbox itself would put a Reply-To on the mail that just loops to the reader.
  // Unset means the email says how to answer instead of promising a reply works.
  const SUPPORT_INBOUND_ADDRESS = Deno.env.get('SUPPORT_INBOUND_ADDRESS');
  const inboundReady = !!SUPPORT_INBOUND_ADDRESS;

  // One thing left to set, and it fails closed without it: no key, no send, and
  // a line in the logs saying so. The customer's message is already saved by the
  // time this runs, so a refusal here costs the notification and nothing else.
  if (!RESEND_API_KEY) {
    console.error('support-notify is missing RESEND_API_KEY — nothing was emailed');
    return json({ error: 'Email is not configured' }, 500);
  }

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
    if (userError || !userData?.user) return json({ error: 'Not signed in' }, 401);
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

    const sent = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: SUPPORT_FROM,
        to: [SUPPORT_INBOX],
        ...(replyTo ? { reply_to: replyTo } : {}),
        subject,
        html,
        text,
      }),
    });

    if (!sent.ok) {
      const detail = await sent.text();
      console.error('Resend send failed:', sent.status, detail);
      return json({ error: 'Could not send the notification email' }, 502);
    }

    return json({ ok: true });
  } catch (err) {
    console.error('support-notify error:', err);
    return json({ error: 'Unexpected error' }, 500);
  }
});
