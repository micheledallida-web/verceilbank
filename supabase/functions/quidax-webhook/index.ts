// Credits a customer's account when a Bitcoin deposit lands at Quidax.
//
// Quidax posts here whenever something happens on the exchange account. This
// function cares about one thing: a crypto deposit that has confirmed. When one
// arrives it writes a row to `transactions`, and the balance trigger on that
// table moves the account balance — which reaches the customer's open screen
// over Realtime without them refreshing.
//
// Three rules shape everything below, and all three are about not inventing
// money:
//
//   1. Never credit a deposit we cannot attribute with certainty. An unmatched
//      payment is parked in `deposit_events` for a human, not guessed at.
//   2. Never credit the same deposit twice. Quidax will retry a delivery it
//      thinks failed, and a retry must be a no-op.
//   3. Never trust the request. Anything that can post here can mint money, so
//      an unsigned or wrongly signed request is refused before it is read.
//
// This endpoint is public by necessity: Quidax has no Supabase session.

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

async function hmacHex(secret: string, body: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Quidax offers a cleartext signature and an HMAC one, and the header it
// arrives under is not something this code should have to guess wrong once in
// production. Both modes are accepted, across the header names Quidax and
// similar gateways use — and on a mismatch the header names that *were* present
// go to the log, so the first real event tells you exactly what to expect
// rather than leaving you to bisect it.
const SIGNATURE_HEADERS = [
  'quidax-signature',
  'x-quidax-signature',
  'x-signature',
  'signature',
  'x-webhook-signature',
];

async function signatureIsValid(req: Request, rawBody: string, secret: string) {
  let presented = '';
  for (const name of SIGNATURE_HEADERS) {
    const value = req.headers.get(name);
    if (value) { presented = value.trim(); break; }
  }

  if (!presented) {
    console.error('quidax-webhook: no signature header', {
      headers: [...req.headers.keys()],
    });
    return false;
  }

  // Cleartext: the header is the shared secret itself.
  if (secretMatches(presented, secret)) return true;

  // HMAC-SHA256 of the raw body, hex, with or without a `sha256=` prefix.
  const computed = await hmacHex(secret, rawBody);
  const bare = presented.replace(/^sha256=/i, '').toLowerCase();
  if (secretMatches(bare, computed)) return true;

  console.error('quidax-webhook: signature did not match', {
    headers: [...req.headers.keys()],
    presentedLength: presented.length,
  });
  return false;
}

// Quidax's payload shape is read defensively rather than assumed, in the same
// spirit as support-inbound: field names move between versions, and a deposit
// that fails to parse is money that silently does not arrive.
function readDeposit(payload: any) {
  const event = String(payload?.event ?? payload?.type ?? '');
  const d = payload?.data ?? payload ?? {};
  const wallet = d.wallet ?? d.payment_address ?? {};

  return {
    event,
    // The exchange's own id for this deposit. This is what makes a redelivery
    // harmless, so it matters more than anything else here.
    reference: String(d.id ?? d.reference ?? d.txid ?? d.transaction_hash ?? ''),
    currency: String(d.currency ?? wallet.currency ?? '').toLowerCase(),
    amount: Number(d.amount ?? d.value ?? 0),
    status: String(d.status ?? '').toLowerCase(),
    // Whichever of these is present is how the deposit gets attributed.
    address: String(d.deposit_address ?? d.address ?? wallet.address ?? wallet.deposit_address ?? ''),
    quidaxUserId: String(d.user?.id ?? wallet.user?.id ?? d.user_id ?? ''),
    confirmations: Number(d.confirmations ?? 0),
  };
}

// Only a deposit that Quidax itself considers done. 'accepted'/'confirmed'/
// 'done'/'successful' all appear across their event names and status values;
// anything else — pending, submitted, failed — is not money in the account.
const SETTLED = ['accepted', 'confirmed', 'done', 'successful', 'completed', 'success'];

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const WEBHOOK_SECRET = Deno.env.get('QUIDAX_WEBHOOK_SECRET');
  // Which of the customer's accounts a deposit lands in. Checking unless you
  // say otherwise.
  // Savings, because it is the account every customer is guaranteed to hold.
  // It defaulted to 'checking' until the bank stopped offering current accounts,
  // which would have credited a deposit to an account that does not exist —
  // the balance trigger matches on (user_id, account_type) and would update
  // nothing at all.
  const CREDIT_ACCOUNT = Deno.env.get('QUIDAX_CREDIT_ACCOUNT_TYPE') ?? 'savings';

  if (!WEBHOOK_SECRET) {
    console.error('quidax-webhook is missing QUIDAX_WEBHOOK_SECRET');
    return json({ error: 'Webhook is not configured' }, 500);
  }

  // Read once, as text: the HMAC is over the exact bytes Quidax sent, so the
  // body cannot be re-serialised before it is checked.
  const rawBody = await req.text();
  if (!(await signatureIsValid(req, rawBody, WEBHOOK_SECRET))) {
    return json({ error: 'Not authorised' }, 401);
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: 'Body is not JSON' }, 400);
  }

  const deposit = readDeposit(payload);
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // Every delivery is recorded before anything is decided about it, so there is
  // always a record of what Quidax said even when this function later refuses
  // to act on it. `reference` is unique, so a redelivery lands on the existing
  // row instead of a second one.
  const { data: recorded, error: recordError } = await admin
    .from('deposit_events')
    .upsert({
      reference: deposit.reference || `unref-${crypto.randomUUID()}`,
      event_type: deposit.event,
      currency: deposit.currency,
      amount: deposit.amount,
      address: deposit.address,
      quidax_user_id: deposit.quidaxUserId,
      status: deposit.status,
      payload,
    }, { onConflict: 'reference', ignoreDuplicates: false })
    .select('id, credited_transaction_id')
    .maybeSingle();

  if (recordError) {
    console.error('quidax-webhook could not record the event:', recordError);
    return json({ error: 'Could not record the event' }, 500);
  }

  // Rule 2. Already credited, so this is a redelivery and there is nothing to
  // do. 200, because Quidax should stop retrying.
  if (recorded?.credited_transaction_id) {
    return json({ ok: true, already_credited: true });
  }

  // Not a settled crypto deposit — a withdrawal, a pending confirmation, a
  // failure. Recorded above, acted on here only when it is money that arrived.
  const settled = SETTLED.some((s) => deposit.event.includes(s) || deposit.status === s);
  const isDeposit = deposit.event.includes('deposit') || !!deposit.address;
  if (!isDeposit || !settled || !(deposit.amount > 0)) {
    return json({ ok: true, ignored: true, event: deposit.event, status: deposit.status });
  }

  // Rule 1. Which customer is this? The deposit request holds the address that
  // was shown to them, so the address is the link. Without a match nothing is
  // credited — the row sits in deposit_events awaiting a human, which is the
  // right outcome for money whose owner is not known.
  let request: any = null;

  // The exchange's own user id is the only unambiguous link, so it is tried
  // first. It is present when deposits are taken on per-customer sub-accounts.
  if (deposit.quidaxUserId) {
    const { data } = await admin
      .from('deposit_requests')
      .select('*')
      .eq('quidax_user_id', deposit.quidaxUserId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    request = data;
  }

  // Falling back to the address, which is only safe while an address belongs to
  // exactly one customer.
  //
  // THIS BANK CURRENTLY SHOWS EVERY CUSTOMER THE SAME RECEIVING ADDRESS. So
  // "the most recent request for this address" is not the person who paid — it
  // is whoever opened the Fund Account screen last. Taking it would credit a
  // stranger's deposit to them, and bitcoin has no chargeback.
  //
  // Instead: read the open requests for this address, and act only when they
  // all belong to one customer. Where two or more people are waiting on the
  // same address the deposit is left unattributed for a human, which is the
  // only honest answer. This resolves itself once deposits are taken on
  // per-customer addresses, at which point the ambiguity cannot arise.
  if (!request && deposit.address) {
    const { data: candidates } = await admin
      .from('deposit_requests')
      .select('*')
      .eq('address', deposit.address)
      .eq('status', 'awaiting')
      .order('created_at', { ascending: false })
      .limit(50);

    const owners = new Set((candidates ?? []).map((row: any) => row.user_id));
    if (owners.size === 1) {
      request = candidates![0];
    } else if (owners.size > 1) {
      console.error('quidax-webhook: shared address, cannot attribute', {
        reference: deposit.reference,
        address: deposit.address,
        waiting: owners.size,
      });
    }
  }

  if (!request?.user_id) {
    console.error('quidax-webhook could not attribute a deposit', {
      reference: deposit.reference,
      address: deposit.address,
      quidaxUserId: deposit.quidaxUserId,
    });
    // 200 on purpose: the event is safely stored and retrying will not help.
    // Assign it by hand — see docs/supabase-setup.md, section 5e.
    return json({ ok: true, unattributed: true });
  }

  // What the deposit is worth in dollars. The rate the customer was quoted is
  // held on their request, so the amount credited is the amount they were shown
  // — not today's rate, which will have moved while they sent it.
  const rate = Number(request.quoted_rate) > 0
    ? Number(request.quoted_rate)
    : Number((await admin.from('bank_settings').select('btc_usd_rate').eq('id', 1).maybeSingle()).data?.btc_usd_rate ?? 0);

  if (!(rate > 0)) {
    console.error('quidax-webhook has no rate to convert with', { reference: deposit.reference });
    return json({ ok: true, unpriced: true });
  }

  const usd = Math.round(deposit.amount * rate * 100) / 100;

  const { data: tx, error: txError } = await admin
    .from('transactions')
    .insert({
      // Deterministic, so even a race between two deliveries collides on the
      // unique index instead of crediting twice.
      local_id: `quidax:${deposit.reference}`,
      user_id: request.user_id,
      account_type: request.account_type || CREDIT_ACCOUNT,
      amount: usd,
      title: 'Bitcoin deposit',
      icon_text: '↓',
      category: 'deposit',
      reference_number: deposit.reference,
      status: 'completed',
    })
    .select('id')
    .maybeSingle();

  if (txError) {
    // 23505 is the unique violation — the deposit was credited by a delivery
    // that arrived a moment earlier. Not an error, just a race we won.
    if ((txError as any).code === '23505') return json({ ok: true, already_credited: true });
    console.error('quidax-webhook could not write the ledger row:', txError);
    return json({ error: 'Could not credit the deposit' }, 500);
  }

  await admin.from('deposit_events')
    .update({ credited_transaction_id: tx?.id ?? null, user_id: request.user_id })
    .eq('reference', deposit.reference);

  await admin.from('deposit_requests')
    .update({ status: 'credited', credited_at: new Date().toISOString() })
    .eq('id', request.id);

  await admin.from('activity_events').insert({
    local_id: `quidax-credit:${deposit.reference}`,
    user_id: request.user_id,
    event_type: 'deposit.credited',
    detail: { amount_usd: usd, btc: deposit.amount, rate, reference: deposit.reference },
    occurred_at: new Date().toISOString(),
  });

  return json({ ok: true, credited: usd });
});
