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

// The outbox before anybody has signed in. Sign-up and sign-in both write here
// — they have events worth keeping and no user id to put on them yet — and
// whoever signs in next adopts what is in it.
const QUEUE_KEY = 'verceil_activity_queue';
const LOG_KEY = 'verceil_activity_log';

// Exported so sign-out knows which keys are the durable outbox and leaves them
// alone. Everything else of ours is cleared.
export const ACTIVITY_QUEUE_KEY_PREFIX = QUEUE_KEY;

// Once the account holder is known, the outbox and the log move to keys of
// their own. This is not tidiness: one shared queue on a device where two
// people bank — or where somebody signs up for a second account — mixes their
// rows together, and every one of those rows is rejected by row-level security
// when it goes out under the wrong session. A rejected row stays queued, the
// batch it is in keeps failing, and NOTHING that customer does is ever written
// again. Balances move off ledger rows, so the visible symptom is an account
// that has quietly stopped working.
//
// A key per account holder is what makes that impossible: your queue is only
// ever flushed by your own session.
function scopedKey(base, id) {
  return id ? `${base}:${id}` : base;
}

// The queue is a durable outbox and the log is a local mirror for reading. Both
// are capped: a device that has been offline for a week should not fill its
// storage quota, and the oldest entries are the least useful.
const MAX_QUEUE = 200;
const MAX_LOG = 100;

let supabase = null;
let userId = '';
let flushing = false;

function queueKey() {
  return scopedKey(QUEUE_KEY, userId);
}

function logKey() {
  return scopedKey(LOG_KEY, userId);
}

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
  const key = queueKey();
  const queue = readStore(key);
  queue.push({ table, row, queued_at: new Date().toISOString() });
  writeStore(key, queue, MAX_QUEUE);
}

// ---------- Public API ----------

// Called once by js/main.js when the Supabase client and the signed-in user are
// both known. Everything below is safe to call before this — it queues.
export function initActivity({ supabaseClient, currentUserId }) {
  supabase = supabaseClient || null;
  userId = currentUserId || '';
  adoptPreSignInRows();
  flushQueue();
}

// What sign-up and sign-in left in the shared outbox. Those rows were written
// before anybody was identified, so they belong to whoever has just signed in —
// with two exceptions, both of which are dropped rather than sent:
//
//   • a row already stamped with a DIFFERENT user id. It is the previous
//     account holder's, this session cannot write it, and trying forever is
//     what took the ledger down. It is theirs to flush when they sign in.
//   • a row older than a day. Nobody is owed an audit trail from a sign-in
//     attempt made last week, and adopting one attributes it to the wrong
//     person.
const ADOPTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function adoptPreSignInRows() {
  if (!userId) return;
  const shared = readStore(QUEUE_KEY);
  if (!shared.length) return;

  const cutoff = Date.now() - ADOPTION_MAX_AGE_MS;
  const mine = shared.filter((item) => {
    const owner = item && item.row && item.row.user_id;
    if (owner && owner !== userId) return false;
    const queuedAt = Date.parse((item && item.queued_at) || '');
    return !Number.isFinite(queuedAt) || queuedAt >= cutoff;
  });

  // The shared outbox is emptied either way. Anything left in it is another
  // account's or too old to attribute, and both are rows this device should
  // stop carrying.
  writeStore(QUEUE_KEY, [], MAX_QUEUE);
  if (!mine.length) return;

  const key = queueKey();
  const own = readStore(key);
  writeStore(key, own.concat(mine.map((item) => ({
    ...item,
    row: { ...item.row, user_id: userId },
  }))), MAX_QUEUE);
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

  const key = logKey();
  const log = readStore(key);
  log.push(row);
  writeStore(key, log, MAX_LOG);

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
  return readStore(logKey()).slice(-limit).reverse();
}

// A failure this row will never recover from, however many times it is tried.
// Row-level security refusing it, a check constraint, a column that does not
// exist: none of those become true later, so the row is dropped instead of
// being carried forever.
//
// Everything else — a timeout, a dropped socket, a 5xx — is left alone. That is
// what the queue is for.
const PERMANENT_ERROR_CODES = [
  '42501', // insufficient privilege
  '42703', // undefined column
  '42P01', // undefined table
  '23502', // not-null violation
  '23503', // foreign key violation
  '23514', // check violation
  '22P02', // invalid text representation
  'PGRST204', // column not found in schema cache
];

function isPermanent(err) {
  if (!err) return false;
  if (PERMANENT_ERROR_CODES.includes(err.code)) return true;
  // PostgREST reports an RLS refusal as a 403 with a message rather than a
  // Postgres SQLSTATE, so the message is read as well.
  return /row-level security|violates row-level/i.test(err.message || '');
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
  const key = queueKey();
  const batch = readStore(key);
  if (!batch.length) return;

  flushing = true;
  // Rows that went out, and rows that never will. Both leave the queue; only
  // the first kind counts as progress.
  const sentIds = [];
  const droppedIds = [];

  // One row at a time, and only after its batch has already failed. A single
  // bad row used to take its whole table's batch down with it and then sit
  // there failing it again on every load — so the batch is retried row by row
  // to find out which one it is, rather than punishing the other twenty-nine.
  async function sendIndividually(table, items) {
    for (const item of items) {
      const row = { ...item.row, user_id: item.row.user_id || userId };
      try {
        const { error } = await supabase.from(table).upsert([row], {
          onConflict: 'local_id',
          ignoreDuplicates: true,
        });
        if (error) throw error;
        sentIds.push(item.row.local_id);
      } catch (err) {
        if (isPermanent(err)) {
          console.error(`Activity row dropped (${table}), it can never be written:`, err);
          droppedIds.push(item.row.local_id);
        } else {
          console.error(`Activity flush error (${table}):`, err);
        }
      }
    }
  }

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
        console.error(`Activity flush error (${table}):`, err);
        await sendIndividually(table, items);
      }
    }
  } finally {
    // Re-read rather than write the batch back. Anything recorded while the
    // request was in flight — the credit half of a transfer, say, enqueued a
    // tick after the debit — is in the queue by now, and writing back the
    // batch we started with would erase it. Only what actually went out is
    // removed, matched on the client-side id.
    const settled = new Set(sentIds.concat(droppedIds));
    const current = readStore(key);
    const kept = current.filter((item) => !settled.has(item.row.local_id));
    writeStore(key, kept, MAX_QUEUE);
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
