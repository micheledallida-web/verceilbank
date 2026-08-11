// ==================== LEDGER AND EVENT LOG ====================
// Two things every bank does that this app was not doing.
//
// 1. A ledger. Money movements were each written to their own table —
//    `transfers`, `payments`, `wire_transfers`, `external_transfers`,
//    `investment_orders` — and none of them to `transactions`, which is the
//    table the account screens actually read. So a transfer succeeded, was
//    recorded, and then did not appear in the account's activity list.
//    recordTransaction() writes the ledger row alongside whatever
//    product-specific row the flow already writes.
//
// 2. An event log. Who signed in, what screen they opened, what they changed.
//    recordEvent() writes those to `activity_events`.
//
// Both are offline-first, which is the part that matters on a phone. Every
// write is appended to a queue in localStorage first and flushed to Supabase
// after; anything the network loses stays in the queue and goes out on the next
// load or the next time the device comes back online. Nothing a customer does
// is lost because a tunnel swallowed one request.

const QUEUE_KEY = 'verceil_activity_queue';
const LOG_KEY = 'verceil_activity_log';

// The queue is a durable outbox and the log is a local mirror for reading. Both
// are capped: a device that has been offline for a week should not fill its
// storage quota, and the oldest entries are the least useful.
const MAX_QUEUE = 200;
const MAX_LOG = 100;

let supabase = null;
let userId = '';
let flushing = false;

function readStore(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    return [];
  }
}

function writeStore(key, rows, cap) {
  try {
    localStorage.setItem(key, JSON.stringify(rows.slice(-cap)));
  } catch (err) {
    // Storage full or blocked. Dropping the oldest half is better than losing
    // every subsequent write for the rest of the session.
    try {
      localStorage.setItem(key, JSON.stringify(rows.slice(-Math.floor(cap / 2))));
    } catch (err2) {}
  }
}

// A client-side id, so a row queued twice — a flush that timed out after the
// insert landed, say — can be recognised as the same row rather than written
// again. It is the natural key for an `on conflict do nothing` upsert.
function newLocalId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function enqueue(table, row) {
  const queue = readStore(QUEUE_KEY);
  queue.push({ table, row, queued_at: new Date().toISOString() });
  writeStore(QUEUE_KEY, queue, MAX_QUEUE);
}

// ---------- Public API ----------

// Called once by js/main.js when the Supabase client and the signed-in user are
// both known. Everything below is safe to call before this — it queues.
export function initActivity({ supabaseClient, currentUserId }) {
  supabase = supabaseClient || null;
  userId = currentUserId || '';
  flushQueue();
}

/**
 * Record something that happened. Fire-and-forget by design: no caller should
 * be made to wait on an audit write, and none of them should have to handle
 * its failure either.
 *
 * @param {string} type   dotted event name, e.g. 'transfer.completed'
 * @param {object} detail anything worth keeping. Never put a full account
 *                        number, an SSN or a password in here.
 */
export function recordEvent(type, detail = {}) {
  const row = {
    local_id: newLocalId(),
    user_id: userId || null,
    event_type: type,
    detail,
    occurred_at: new Date().toISOString(),
  };

  const log = readStore(LOG_KEY);
  log.push(row);
  writeStore(LOG_KEY, log, MAX_LOG);

  enqueue('activity_events', row);
  flushQueue();
  return row;
}

/**
 * Write a ledger row — the thing the account screens read. Call it from every
 * flow that moves money, in addition to whatever product table that flow
 * already writes.
 *
 * `amount` is signed: negative leaves the account, positive arrives in it.
 */
export function recordTransaction({
  accountType,
  amount,
  title,
  dateInfo,
  iconText,
  category,
  reference,
  status = 'completed',
}) {
  const row = {
    local_id: newLocalId(),
    user_id: userId || null,
    account_type: accountType,
    amount,
    title,
    // The account screens print this string as-is, so it is composed here
    // rather than leaving each caller to invent its own date format.
    date_info: dateInfo || new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    icon_text: iconText || (Number(amount) < 0 ? '↑' : '↓'),
    category: category || null,
    reference_number: reference || null,
    status,
  };

  enqueue('transactions', row);
  flushQueue();

  // The ledger row is an event too, so a single log tells the whole story of a
  // session without joining two tables to read it.
  recordEvent('transaction.recorded', {
    account_type: accountType,
    amount,
    title,
    reference,
    status,
  });

  return row;
}

// What this device has seen, newest first. Used by any screen that wants to
// show recent activity without waiting on the network.
export function readLocalActivity(limit = 20) {
  return readStore(LOG_KEY).slice(-limit).reverse();
}

/**
 * Push everything queued. Rows that go out are dropped from the queue; rows
 * that fail stay in it, so this is safe to call as often as you like.
 *
 * Deliberately quiet: a failure here is a retry, not something to interrupt
 * somebody's banking with.
 */
export async function flushQueue() {
  if (flushing || !supabase || !userId) return;
  const batch = readStore(QUEUE_KEY);
  if (!batch.length) return;

  flushing = true;
  const sentIds = [];

  try {
    // Grouped by table so a queue of thirty rows is two requests, not thirty.
    const byTable = batch.reduce((acc, item) => {
      (acc[item.table] = acc[item.table] || []).push(item);
      return acc;
    }, {});

    for (const table of Object.keys(byTable)) {
      const items = byTable[table];
      // A row queued before sign-in has no user on it; it belongs to whoever
      // is signed in now, which is the only person who could have caused it.
      const rows = items.map((item) => ({ ...item.row, user_id: item.row.user_id || userId }));
      try {
        const { error } = await supabase.from(table).upsert(rows, {
          onConflict: 'local_id',
          ignoreDuplicates: true,
        });
        if (error) throw error;
        sentIds.push(...items.map((item) => item.row.local_id));
      } catch (err) {
        // Left in the queue, and tried again on the next flush.
        console.error(`Activity flush error (${table}):`, err);
      }
    }
  } finally {
    // Re-read rather than write the batch back. Anything recorded while the
    // request was in flight — the credit half of a transfer, say, enqueued a
    // tick after the debit — is in the queue by now, and writing back the
    // batch we started with would erase it. Only what actually went out is
    // removed, matched on the client-side id.
    const sent = new Set(sentIds);
    const current = readStore(QUEUE_KEY);
    const kept = current.filter((item) => !sent.has(item.row.local_id));
    writeStore(QUEUE_KEY, kept, MAX_QUEUE);
    flushing = false;

    // Something arrived mid-flight and is still waiting. Only chased when this
    // pass made progress, so a queue that is failing does not spin.
    if (kept.length && sentIds.length) flushQueue();
  }
}

// ==================== REALTIME ====================
// Every subscription in the app went out as a bare `.subscribe()`, which takes
// an optional status callback that nobody was passing. That is the whole
// difference between realtime working and realtime silently not working:
//
//   • A table missing from the `supabase_realtime` publication produces a
//     channel that joins and then never delivers anything. No error, no
//     warning, nothing on the console — the screen simply never updates, and
//     it looks identical to an account where nothing has happened.
//   • A dropped socket (a tunnel, a sleeping phone, a switch from wifi to
//     mobile) closed the channel and it stayed closed for the rest of the
//     session. The balance on screen then quietly stopped being live.
//
// This wraps both. Status goes to the console under [realtime], and a channel
// that errors is rebuilt with a backoff instead of being abandoned.

const liveChannels = new Map();

function subscribeChannel(build, label) {
  let channel = null;
  let attempt = 0;
  let timer = null;
  let stopped = false;

  const open = () => {
    channel = build();
    channel.subscribe((status, err) => {
      if (stopped) return;
      liveChannels.set(label, status);

      if (status === 'SUBSCRIBED') {
        attempt = 0;
        console.info(`[realtime] ${label}: live`);
        return;
      }
      // Fired by our own removeChannel too, so it is not on its own a fault.
      if (status === 'CLOSED') return;

      // CHANNEL_ERROR / TIMED_OUT. The most common cause by far is the table
      // not being in the publication — see section 8 of supabase/setup.sql.
      console.error(`[realtime] ${label}: ${status}`, err || '');
      retry();
    });
  };

  const retry = () => {
    if (stopped || timer) return;
    // 2s, 4s, 8s ... capped at 30. Capped rather than unbounded because the
    // customer may simply be in a lift, and a channel that gives up entirely
    // is the bug this exists to fix.
    const wait = Math.min(30000, 2000 * Math.pow(2, attempt++));
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      try { supabase.removeChannel(channel); } catch (err) {}
      open();
    }, wait);
  };

  open();

  return () => {
    stopped = true;
    liveChannels.delete(label);
    if (timer) { clearTimeout(timer); timer = null; }
    try { supabase.removeChannel(channel); } catch (err) {}
  };
}

/**
 * Opens a filtered realtime channel with status reporting and reconnection.
 * `build` is called with the client and must return a channel with its
 * `.on(...)` handlers already attached, but NOT subscribed.
 */
export function watchRealtime(build, label) {
  if (!supabase || !userId) return () => {};
  return subscribeChannel(() => build(supabase), label);
}

/**
 * The inbound flow. Subscribes to this user's ledger and event rows so the app
 * reacts to anything written elsewhere — a representative posting a credit, a
 * transfer made on another device, an administrator correcting a record.
 *
 * Returns an unsubscribe function.
 */
export function subscribeToActivity(handler) {
  return watchRealtime((client) => client
    .channel(`activity:${userId}`)
    // Scoped to this user. An unfiltered subscription hands you every other
    // account holder's rows.
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'transactions',
      filter: `user_id=eq.${userId}`,
    }, (payload) => handler({ kind: 'transaction', row: payload.new }))
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'activity_events',
      filter: `user_id=eq.${userId}`,
    }, (payload) => handler({ kind: 'event', row: payload.new })),
  'activity');
}

// Answers "is realtime actually on?" from the console, the same way
// VerceilAuth.probe() answers it for auth. Every channel should read
// SUBSCRIBED; anything else names itself and the reason is on the console
// above.
if (typeof window !== 'undefined') {
  window.VerceilRealtime = {
    status: () => Object.fromEntries(liveChannels),
  };
}

// Anything stranded by a dropped connection goes out the moment the device is
// back, rather than waiting for the next page load.
window.addEventListener('online', () => flushQueue());
