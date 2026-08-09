// Turns a reply to a support email back into a message in the customer's app.
//
// Resend posts every inbound email here. The thread is identified by the plus
// tag on the address it was sent to — support+<thread-id>@domain — which is
// what the outbound side put in Reply-To, so answering is just hitting reply.
//
// This endpoint is public by necessity: Resend has no Supabase session. It is
// guarded by a shared secret in the URL, because anything that can post here
// can write messages that the customer will read as coming from their bank.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Compared without an early exit, so the response time does not leak how much
// of the secret was right.
function secretMatches(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Resend's inbound payload has moved around between versions, so the fields are
// read defensively rather than assuming one shape.
function pick(payload: any) {
  const data = payload?.data ?? payload ?? {};
  const toField = data.to ?? data.To ?? data.recipient ?? '';
  const to = Array.isArray(toField) ? toField.join(',') : String(toField);
  return {
    to,
    subject: String(data.subject ?? data.Subject ?? ''),
    text: String(data.text ?? data.TextBody ?? data['body-plain'] ?? ''),
    html: String(data.html ?? data.HtmlBody ?? ''),
  };
}

// The plus tag first, the subject tag as a fallback for clients that rewrite
// the address.
function findThreadId(to: string, subject: string) {
  const plus = to.match(/\+([^@\s>,]+)@/);
  if (plus) return plus[1];
  const tagged = subject.match(/\[VB-([^\]]+)\]/);
  if (tagged) return tagged[1];
  return '';
}

// Everything from the first quote marker down is the email being replied to.
// Without this the customer would receive their own message back underneath
// every answer, growing with each round.
function stripQuotedReply(body: string) {
  const markers = [
    /^\s*On .+ wrote:\s*$/m,
    /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/mi,
    /^\s*_{5,}\s*$/m,
    /^\s*From:\s.+$/m,
    /^\s*>{1,}\s?/m,
  ];
  let cut = body.length;
  for (const marker of markers) {
    const found = body.match(marker);
    if (found && found.index !== undefined && found.index < cut) cut = found.index;
  }
  return body.slice(0, cut).replace(/\s+$/, '');
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const INBOUND_SECRET = Deno.env.get('SUPPORT_INBOUND_SECRET');

  if (!INBOUND_SECRET) {
    console.error('support-inbound is missing SUPPORT_INBOUND_SECRET');
    return json({ error: 'Inbound is not configured' }, 500);
  }

  const token = new URL(req.url).searchParams.get('token') ?? '';
  if (!secretMatches(token, INBOUND_SECRET)) return json({ error: 'Not authorised' }, 401);

  try {
    const payload = await req.json();
    const { to, subject, text, html } = pick(payload);

    const threadId = findThreadId(to, subject);
    if (!threadId) {
      // Answered without the tag intact. Better to say so in the logs than to
      // guess a thread and put an answer in front of the wrong customer.
      console.error('support-inbound could not find a thread id', { to, subject });
      return json({ error: 'No thread id on the message' }, 422);
    }

    const raw = text || html.replace(/<[^>]+>/g, ' ');
    const body = stripQuotedReply(raw).trim();
    if (!body) return json({ error: 'Empty reply' }, 422);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: thread, error: threadError } = await admin
      .from('support_threads')
      .select('*')
      .eq('id', threadId)
      .maybeSingle();
    if (threadError) throw threadError;
    if (!thread) return json({ error: 'Thread not found' }, 404);

    const { error: insertError } = await admin.from('support_messages').insert({
      thread_id: thread.id,
      user_id: thread.user_id,
      sender: 'support',
      body,
    });
    if (insertError) throw insertError;

    // 'answered' is what puts the dot on the thread and the count on the
    // Support tab, so the customer sees there is something waiting.
    const { error: updateError } = await admin
      .from('support_threads')
      .update({ status: 'answered', updated_at: new Date().toISOString() })
      .eq('id', thread.id);
    if (updateError) throw updateError;

    return json({ ok: true });
  } catch (err) {
    console.error('support-inbound error:', err);
    return json({ error: 'Unexpected error' }, 500);
  }
});
