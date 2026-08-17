// Issues an offer code, emails it, and starts its clock.
//
// This is the piece the expiry work was missing. `offer_codes.sent_at` is what
// the seven-day window counts from, and until something set it, every issued
// code sat with sent_at null — which the database reads as "not sent yet, so
// not yet ageing". Correct behaviour, but it meant no code ever expired.
//
// THE ORDER IS THE POINT
//
// Mint -> send -> mark sent. The mark happens only after Resend has accepted
// the message, never before. Marking first and sending second means a bounced
// or refused send still costs the recipient their window: they never get the
// email, and the code quietly dies seven days later anyway.
//
// If the send fails the code is left behind, unsent. That is deliberate too —
// it is inert (nobody has been told it, and with sent_at null it cannot age),
// and deleting it would risk destroying a code on an ambiguous failure where
// the mail actually went out. They are easy to find and clear up:
//
//   select code, label, created_at from public.offer_codes where sent_at is null;
//
// NOT A CUSTOMER ENDPOINT
//
// Issuing invitations is the bank's job. This is guarded by a shared secret
// rather than a customer session — there is no signed-in user who should be
// able to mint themselves an invitation.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

// Compared without an early return, so the time taken does not depend on how
// many leading characters were right. A plain === on a secret leaks its prefix
// to anybody willing to measure, one character at a time.
function secretMatches(supplied: string, expected: string) {
  const a = new TextEncoder().encode(supplied);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// Seven digits, leading digit 1-9 — the same nine-million space the throttle on
// offer_code_status does its arithmetic against.
//
// crypto.getRandomValues rather than Math.random, which is seeded predictably
// and is not a secret generator: an attacker who saw a few issued codes could
// work out the sequence and mint the rest for themselves. Rejection sampling
// rather than a modulo, because 2^32 does not divide evenly by nine million and
// the remainder would make some codes measurably likelier than others.
function mintCode() {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / 9000000) * 9000000;
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= limit);
  return String(1000000 + (n % 9000000));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
  const ADMIN_SECRET = Deno.env.get('OFFER_CODE_ADMIN_SECRET');
  // The invitation can go out from the support address; there is nothing wrong
  // with an applicant replying to it, and one fewer domain to verify.
  const FROM = Deno.env.get('OFFER_CODE_FROM') ?? Deno.env.get('SUPPORT_FROM');

  if (!RESEND_API_KEY || !FROM) {
    console.error('send-offer-code is missing RESEND_API_KEY or OFFER_CODE_FROM/SUPPORT_FROM');
    return json({ error: 'Email is not configured' }, 500);
  }

  // No secret set means no way to tell the operator from a stranger. Refusing
  // is the only safe reading of that — an unset secret must never mean "let
  // everybody through", which is what a `!ADMIN_SECRET || ...` check would do.
  if (!ADMIN_SECRET) {
    console.error('send-offer-code is missing OFFER_CODE_ADMIN_SECRET — refusing every request');
    return json({ error: 'Not configured' }, 500);
  }

  const supplied = req.headers.get('x-admin-secret') ?? '';
  if (!secretMatches(supplied, ADMIN_SECRET)) return json({ error: 'Not authorised' }, 401);

  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body.email ?? '').trim();
    const label = body.label ? String(body.label).slice(0, 120) : null;
    const maxUses = Number.isInteger(body.max_uses) && body.max_uses > 0 ? body.max_uses : 1;
    const requested = body.code ? String(body.code).replace(/\D/g, '') : '';

    // Deliberately shallow. This is not validating that an address exists, only
    // that it is not obviously not one — Resend decides the rest, and a stricter
    // regex here would reject valid addresses nobody would think to test.
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json({ error: 'A valid email address is required' }, 400);
    }
    if (requested && !/^[0-9]{7}$/.test(requested)) {
      return json({ error: 'code must be seven digits' }, 400);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    let code = requested;
    let minted = false;

    if (code) {
      // Resending an existing invitation. Note that mark_offer_code_sent will
      // NOT move the deadline if this code has already been sent once — a
      // resend is a second copy of the same invitation, not a fresh window.
      const { data: existing, error } = await admin
        .from('offer_codes').select('code').eq('code', code).maybeSingle();
      if (error) throw error;
      if (!existing) return json({ error: 'No such code' }, 404);
    } else {
      // Retry only on a duplicate. Seven digits is a wide space, so a clash is
      // rare, but "rare" over enough invitations is "eventually", and the
      // unique constraint is what makes this safe to just try again.
      for (let attempt = 0; attempt < 5 && !code; attempt++) {
        const candidate = mintCode();
        const { error } = await admin.from('offer_codes').insert({
          code: candidate, label, max_uses: maxUses, active: true,
        });
        if (!error) { code = candidate; minted = true; break; }
        if (error.code !== '23505') throw error;
      }
      if (!code) return json({ error: 'Could not allocate a code, please retry' }, 503);
    }

    const subject = 'Your Verceil Bank invitation code';
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#111827;font-size:14px;line-height:1.55">
        <p style="margin:0 0 16px">You have been invited to open an account with Verceil Bank.</p>
        <p style="margin:0 0 8px">Your offer code is:</p>
        <p style="margin:0 0 20px;font-size:30px;font-weight:700;letter-spacing:6px;color:#117ACA">${escapeHtml(code)}</p>
        <p style="margin:0 0 16px">Enter it when you apply. This code is for one account and expires seven days from today.</p>
        <hr style="border:0;border-top:1px solid #E5E7EB;margin:20px 0">
        <p style="margin:0;color:#6B7480;font-size:12px">If you were not expecting this, you can ignore it — the code is useless without an application.</p>
      </div>`;
    const text = [
      'You have been invited to open an account with Verceil Bank.',
      '',
      `Your offer code is: ${code}`,
      '',
      'Enter it when you apply. This code is for one account and expires seven days from today.',
      '',
      'If you were not expecting this, you can ignore it.',
    ].join('\n');

    const sent = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [email], subject, html, text }),
    });

    if (!sent.ok) {
      const detail = await sent.text();
      console.error('Resend send failed:', sent.status, detail, minted ? `(code ${code} left unsent)` : '');
      return json({ error: 'Could not send the invitation' }, 502);
    }

    // Only now. The message is accepted, so the window may start.
    const { data: deadline, error: markError } = await admin
      .rpc('mark_offer_code_sent', { p_code: code });

    // The mail is already gone, so this is not a failure to report as one — but
    // it does mean the code is live with no deadline, which somebody has to fix
    // by hand. Loud in the logs, and named in the response.
    if (markError) {
      console.error('SENT BUT NOT MARKED — code', code, 'has no expiry until sent_at is set:', markError);
      return json({ ok: true, code, expires_at: null, warning: 'sent, but the clock was not started' });
    }

    return json({ ok: true, code, expires_at: deadline, minted });
  } catch (err) {
    console.error('send-offer-code error:', err);
    return json({ error: 'Unexpected error' }, 500);
  }
});
