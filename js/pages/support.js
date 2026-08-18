// Support tab. Four views live in the one fragment — the home screen, the
// message list, a thread, and the new-message form — because they share one
// back stack and swapping a hidden class is cheaper than tearing the page down
// and refetching on every hop between them.

import { SUPPORT_PHONE, SUPPORT_PHONE_DISPLAY, SUPPORT_EMAIL } from '../shared/account-products.js';
import { SUPPORT_TOPICS } from '../shared/support-topics.js';

// The categories the support_threads table accepts, paired with something a
// person would actually recognise. This is the only place the mapping lives.
// `value` is what is written to support_threads.category, and it is the only
// thing here another screen may hand in. Four screens used to pass their own
// display labels instead — 'Account', 'Accounts', 'Investments' — none of which
// match a value, so every one of them silently filed its message under General
// and support saw a name change, an IRA rollover and a joint-owner request as
// the same undifferentiated pile. The values below cover what those screens
// actually ask about.
const SUPPORT_CATEGORIES = [
  { value: 'general', label: 'General' },
  { value: 'card_application', label: 'Card application' },
  { value: 'funding_zelle', label: 'Funding — Zelle' },
  { value: 'funding_cashapp', label: 'Funding — Cash App' },
  { value: 'funding_paypal', label: 'Funding — PayPal' },
  { value: 'funding_ach', label: 'Funding — ACH transfer' },
  { value: 'disputes', label: 'Disputes' },
  { value: 'account_access', label: 'Account access' },
  { value: 'account_ownership', label: 'Joint account ownership' },
  { value: 'investments', label: 'Investments' },
  { value: 'personal_details', label: 'Personal details' },
];

const STATUS_LABELS = { open: 'Open', answered: 'Answered', closed: 'Closed' };

const STATUS_PILL_CLASSES = {
  open: 'bg-blue-50 dark:bg-white/10 text-[#2563EB] dark:text-[#3B82F6]',
  answered: 'bg-green-50 dark:bg-white/10 text-[#16A34A] dark:text-[#4ADE80]',
  closed: 'bg-gray-100 dark:bg-white/10 text-[#6B7280] dark:text-[#8E9CBA]',
};

let listeners = [];
let threads = [];
let latestByThread = {};
let activeThread = null;
// Where the conversation was opened from, so its back arrow returns there.
// Sending a new message drops somebody straight into the thread from the home
// screen; backing out of that onto a list they never visited is not going back.
let threadOrigin = 'list';
let activeMessages = [];
let topicFilter = '';
let pendingCategory = '';
let sendingNew = false;
let sendingReply = false;

function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}

// Message bodies and subjects are stored text that comes back out into
// innerHTML. Escaped on the way in so a subject containing markup renders as
// the characters someone typed rather than as part of the page.
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function categoryLabel(value) {
  const found = SUPPORT_CATEGORIES.find((entry) => entry.value === value);
  return found ? found.label : 'General';
}

function statusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS.open;
}

function statusPillClasses(status) {
  return STATUS_PILL_CLASSES[status] || STATUS_PILL_CLASSES.open;
}

// Whole days apart rather than hours, so something sent late last night reads
// as "Yesterday" this morning instead of "Today".
function relativeDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (isNaN(date)) return '';
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// "Aug 18, 1:50 PM". The rail shows both halves because it is a list of
// conversations rather than a list of days: which one was last spoken in, and
// when, is the whole reason to look at it.
function stampDateTime(value) {
  const date = new Date(value);
  if (isNaN(date)) return '';
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function preview(body) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  return text.length > 60 ? text.slice(0, 60) : text;
}

// Hands the message to the edge function that emails the support inbox. Fire
// and forget on purpose: the message is already saved by the time this runs, so
// a mail outage must never surface to the user as a failed send. It is logged
// and nothing else.
// Which deployed function to call.
//
// It is `support-notify` unless something says otherwise, because that is what
// the function is called in this repository and what the setup docs deploy.
// The override exists because the name is not always the deployer's to choose:
// Supabase's dashboard editor generates a name of its own, and a project that
// took that name had an app calling one thing and a function answering to
// another — a 404 the app is deliberately built not to notice, so every
// notification went nowhere while every message saved perfectly.
//
// Set SUPPORT_NOTIFY_FUNCTION in the build environment to point at whatever
// the function is actually called. Renaming it properly later needs no code
// change either: clear the variable and the default is right again.
const NOTIFY_FUNCTION = (typeof window !== 'undefined' && window.SUPPORT_NOTIFY_FUNCTION) || 'support-notify';

function notifySupportInbox(ctx, threadId, messageId) {
  if (!ctx.supabaseClient || !ctx.supabaseClient.functions || !threadId || !messageId) return;
  ctx.supabaseClient.functions
    .invoke(NOTIFY_FUNCTION, { body: { thread_id: threadId, message_id: messageId } })
    .then(({ error }) => { if (error) reportNotifyFailure(error); })
    .catch((err) => reportNotifyFailure(err));
}

// On a non-2xx the client hands back an error whose message is only ever
// "Edge Function returned a non-2xx status code" — the body that says which
// secret is missing, or what Resend refused, hangs off `context` as the raw
// response. Logging the error alone threw that away and left the console
// saying nothing useful about a send that quietly did not happen.
function reportNotifyFailure(error) {
  const response = error && error.context;
  if (!response || typeof response.json !== 'function') {
    console.error('Support email notify error:', error);
    return;
  }
  response.json()
    .then((body) => console.error('Support email notify error:', response.status, body))
    .catch(() => console.error('Support email notify error:', response.status, error));
}

// Errors written here are meant for the customer. Errors from Postgres, from
// the network or from an edge function are not, and until now they went
// straight onto the screen: somebody sending a message to their bank was shown
// "Could not find the table 'public.support_threads' in the schema cache",
// which tells them nothing they can act on and tells anyone else the shape of
// the database. The detail still goes to the console, where it is useful.
class SupportMessageError extends Error {}

function customerFacing(err, fallback) {
  if (err instanceof SupportMessageError && err.message) return err.message;

  // A short reference on the end of the sentence, and the reason is what
  // happened the first time: taking the raw fault off the screen also took away
  // the only way anybody outside the console could say what went wrong, so
  // "could not send" was all anyone had to go on. A code is safe to show — it
  // names a class of fault, not the schema — and it is the difference between
  // "it still fails" and one line that identifies the cause:
  //
  //   PGRST205  the table is not in PostgREST's schema cache: either it was
  //             never created, or it was and the cache has not reloaded yet
  //   42P01     the table really is not there
  //   42501     the row was refused by row level security
  //   23503     the thread this message belongs to does not exist
  const ref = err && (err.code || err.status);
  return ref ? `${fallback} (ref ${String(ref).slice(0, 16)})` : fallback;
}

function emptyState(message) {
  return `<div class="bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[14px] px-[16px] py-3 shadow-lg text-center text-[12px] text-[#6B7280] dark:text-[#8E9CBA]">${message}</div>`;
}

// ---------- View switching ----------

// Which of the four is on screen. Read rather than remembered, so it cannot
// disagree with what somebody is actually looking at.
function currentView(root) {
  if (!root.querySelector('#supListView').classList.contains('hidden')) return 'list';
  if (!root.querySelector('#supNewView').classList.contains('hidden')) return 'new';
  if (!root.querySelector('#supThreadView').classList.contains('hidden')) return 'thread';
  return 'home';
}

function showView(root, name) {
  root.querySelector('#supHomeView').classList.toggle('hidden', name !== 'home');
  root.querySelector('#supListView').classList.toggle('hidden', name !== 'list');
  root.querySelector('#supThreadView').classList.toggle('hidden', name !== 'thread');
  root.querySelector('#supNewView').classList.toggle('hidden', name !== 'new');
  // The composer belongs to the thread view but is positioned against the
  // screen, so it lives outside that container and is toggled alongside it.
  root.querySelector('#supComposer').classList.toggle('hidden', name !== 'thread');
  if (name !== 'thread') root.scrollTop = 0;
}

// ---------- View 1: Support home ----------

// Flat rows on the page background, divided by a hairline — the same row the
// rest of this screen uses. No card, no container.
// One row template, two lists. Funding and everything else are separated
// because they are different questions — "send me the details so I can pay in"
// against "something is wrong with my account" — and a single run of thirteen
// rows buries both.
function topicRowHtml(topic) {
  return `
    <button type="button" class="sup-topic w-full flex items-center gap-[12px] px-[12px] py-[14px] text-left cursor-pointer border-b border-white/15 dark:border-white/[0.08]" data-label="${escapeHtml(topic.label)}">
      <svg class="w-[20px] h-[20px] text-white/80 dark:text-[#8E9CBA] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${topic.icon}</svg>
      <span class="flex-1 min-w-0 text-[15px] font-medium text-white truncate">${escapeHtml(topic.label)}</span>
      <svg class="w-[16px] h-[16px] text-white/60 dark:text-[#52607D] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
    </button>
  `;
}

function renderTopics(root) {
  const needle = topicFilter.trim().toLowerCase();
  const matches = (topic) => !needle || topic.label.toLowerCase().includes(needle);

  const funding = SUPPORT_TOPICS.filter((topic) => topic.group === 'funding' && matches(topic));
  const common = SUPPORT_TOPICS.filter((topic) => topic.group !== 'funding' && matches(topic));

  // A heading with nothing under it reads as a list that failed to load, so
  // each one is hidden along with its rows when the search excludes them all.
  root.querySelector('#supFunding').innerHTML = funding.map(topicRowHtml).join('');
  root.querySelector('#supFundingHead').classList.toggle('hidden', !funding.length);
  root.querySelector('#supFunding').classList.toggle('hidden', !funding.length);

  root.querySelector('#supTopics').innerHTML = common.map(topicRowHtml).join('');
  root.querySelector('#supTopicsHead').classList.toggle('hidden', !common.length);
  root.querySelector('#supTopics').classList.toggle('hidden', !common.length);

  root.querySelector('#supTopicsEmpty').classList.toggle('hidden', !!(funding.length || common.length));
}

// The home row summarises the inbox: what the last conversation was about, and
// how many are waiting on the reader.
function renderThreadsSummary(root) {
  const sub = root.querySelector('#supThreadsSub');
  const pill = root.querySelector('#supAnsweredPill');

  const answered = threads.filter((thread) => thread.status === 'answered').length;
  pill.textContent = String(answered);
  pill.classList.toggle('hidden', answered === 0);

  if (!threads.length) {
    sub.textContent = 'No messages yet';
    return;
  }

  const newest = threads[0];
  const when = relativeDate(newest.updated_at || newest.created_at);
  sub.textContent = [newest.subject, when].filter(Boolean).join(' · ');
}



// The unread count on every history button. It is the same number as the pill
// on the home row and the count on the list, kept in one function so the three
// cannot disagree — a badge that says 2 next to a list showing none is worse
// than no badge.
function renderHistoryBadges(root) {
  const unread = threads.filter((thread) => thread.status === 'answered').length;
  root.querySelectorAll('.sup-history-dot').forEach((dot) => {
    dot.textContent = unread > 9 ? '9+' : String(unread);
    dot.classList.toggle('hidden', unread === 0);
    dot.classList.toggle('flex', unread > 0);
  });
}

// The rail beside an open conversation. Same `threads` array the list view
// draws, same rows, same statuses — read once by loadThreads and drawn twice,
// so the two can never disagree and the second one costs no query.
//
// The click is delegated to the container, registered once in init: these rows
// are rebuilt every time a thread is opened, and a listener per row per render
// would pile up for as long as the screen is open.
function renderRail(root) {
  const list = root.querySelector('#supRailList');
  if (!list) return;

  if (!threads.length) {
    list.innerHTML = '<div class="sup-rail-empty">No conversations yet.</div>';
    return;
  }

  list.innerHTML = threads.map((thread) => {
    const isActive = activeThread && String(activeThread.id) === String(thread.id);
    const isUnread = thread.status === 'answered';
    return `
      <button type="button" class="sup-rail-row${isActive ? ' sup-rail-row-on' : ''}" data-id="${escapeHtml(thread.id)}"${isActive ? ' aria-current="true"' : ''}>
        <span class="sup-rail-row-in">
          <span class="sup-rail-t">
            ${isUnread ? '<span class="sup-rail-dot"></span>' : ''}
            <span class="sup-rail-subj">${escapeHtml(thread.subject)}</span>
          </span>
          <span class="sup-rail-meta">${escapeHtml(statusLabel(thread.status))} &bull; ${escapeHtml(categoryLabel(thread.category))}</span>
          <span class="sup-rail-when">${escapeHtml(stampDateTime(thread.updated_at || thread.created_at))}</span>
        </span>
        <svg class="sup-rail-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
      </button>
    `;
  }).join('');
}

function renderThreads(root, ctx) {
  const list = root.querySelector('#supThreads');
  const unreadEl = root.querySelector('#supUnreadCount');

  const unread = threads.filter((thread) => thread.status === 'answered').length;
  unreadEl.textContent = unread === 1 ? '1 unread' : `${unread} unread`;
  unreadEl.classList.toggle('hidden', unread === 0);

  if (!threads.length) {
    list.innerHTML = `
      <div class="bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[16px] px-[16px] py-4 shadow-lg text-center">
        <div class="text-[13px] font-semibold text-[#111827] dark:text-white">No messages yet</div>
        <div class="text-[12px] text-[#6B7280] dark:text-[#8E9CBA] mt-[4px]">A representative replies within 1 business day.</div>
      </div>
    `;
    return;
  }

  list.innerHTML = threads.map((thread) => {
    const isUnread = thread.status === 'answered';
    const latest = latestByThread[thread.id];
    const previewText = latest ? preview(latest.body) : '';
    return `
      <button class="sup-thread w-full ${isUnread ? 'bg-blue-50 dark:bg-white/5' : 'bg-white dark:bg-[#0D1728]'} border border-transparent dark:border-white/[0.06] rounded-[16px] p-[14px] shadow-lg text-left cursor-pointer" data-id="${escapeHtml(thread.id)}">
        <div class="flex items-start justify-between gap-[12px]">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-[6px]">
              ${isUnread ? '<span class="w-[8px] h-[8px] rounded-full bg-[#2563EB] flex-shrink-0"></span>' : ''}
              <span class="text-[13px] font-bold text-[#111827] dark:text-white truncate">${escapeHtml(thread.subject)}</span>
            </div>
            <div class="text-[12px] text-[#6B7280] dark:text-[#8E9CBA] truncate mt-[2px]">${escapeHtml(previewText)}</div>
          </div>
          <span class="text-[11px] text-[#6B7280] dark:text-[#8E9CBA] flex-shrink-0">${escapeHtml(relativeDate(thread.updated_at || thread.created_at))}</span>
        </div>
        <span class="inline-flex items-center px-[8px] h-[20px] rounded-full text-[10px] font-bold mt-[10px] ${statusPillClasses(thread.status)}">${escapeHtml(statusLabel(thread.status))}</span>
      </button>
    `;
  }).join('');

  list.querySelectorAll('.sup-thread').forEach((btn) => {
    on(btn, 'click', () => {
      const thread = threads.find((entry) => String(entry.id) === btn.getAttribute('data-id'));
      if (thread) openThread(root, ctx, thread);
    });
  });
}

async function loadThreads(root, ctx) {
  const { supabaseClient, getCurrentUser } = ctx;
  threads = [];
  latestByThread = {};

  try {
    const user = await getCurrentUser();
    if (!user || !supabaseClient) {
      renderThreads(root, ctx);
      renderThreadsSummary(root);
      renderRail(root);
      return;
    }

    const { data: threadRows, error: threadError } = await supabaseClient
      .from('support_threads')
      .select('*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false });
    if (threadError) throw threadError;

    threads = threadRows || [];

    if (threads.length) {
      // One query for every thread's messages rather than one per thread, then
      // the newest of each is kept for the preview line.
      const { data: messageRows, error: messageError } = await supabaseClient
        .from('support_messages')
        .select('*')
        .in('thread_id', threads.map((thread) => thread.id))
        .order('created_at', { ascending: false });
      if (messageError) throw messageError;

      (messageRows || []).forEach((message) => {
        if (!latestByThread[message.thread_id]) latestByThread[message.thread_id] = message;
      });
    }
  } catch (err) {
    console.error('Support threads error:', err);
  }

  renderThreads(root, ctx);
  renderThreadsSummary(root);
  renderHistoryBadges(root);
  renderRail(root);
}

// ---------- View 2: Thread detail ----------

// An address or a link inside a reply is usually the thing the customer came
// for — the mailbox to pay into, the page to open — so it is drawn as one
// rather than as characters to copy out by hand.
//
// It runs on text that has already been escaped, so a body containing markup
// is still inert, and it runs in a single pass: two passes would find the
// address inside a `mailto:` this function had just written and nest an anchor
// inside an anchor.
const LINK_PATTERN = /(https?:\/\/[^\s<]+[^\s<.,;:!?)"']|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

function linkify(escaped) {
  return escaped.replace(LINK_PATTERN, (match) => {
    if (/^https?:\/\//.test(match)) {
      return `<a class="sup-link" href="${match}" target="_blank" rel="noopener noreferrer">${match}</a>`;
    }
    return `<a class="sup-link" href="mailto:${match}">${match}</a>`;
  });
}

// The day a message belongs to, and the heading that day gets. The heading
// carries the date so the times under the bubbles do not have to: "2:33 PM"
// under a message is only unambiguous while something above it says which day
// that was.
function dayKey(value) {
  const date = new Date(value);
  if (isNaN(date)) return '';
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(value) {
  const date = new Date(value);
  if (isNaN(date)) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function messageTime(value) {
  const date = new Date(value);
  if (isNaN(date)) return '';
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// One tick is sent, two is read. Nothing in the schema records a read receipt
// and this screen is not the place to add one — but a reply written after a
// message is proof that somebody read it, so that is what the second tick is
// saying, out of rows this screen already has.
function ticksHtml(seen) {
  return `
    <svg class="sup-tick${seen ? ' sup-tick-seen' : ''}" viewBox="0 0 22 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="1 6.6 4.6 10.2 11.4 2.2"></polyline>
      ${seen ? '<polyline points="9.6 10.2 16.4 2.2"></polyline>' : ''}
    </svg>
  `;
}

function renderMessages(root) {
  const list = root.querySelector('#supMessages');

  if (!activeMessages.length) {
    list.innerHTML = emptyState('No messages in this conversation yet.');
    return;
  }

  const lastAgentAt = activeMessages.reduce((latest, message) => {
    if (message.sender === 'user') return latest;
    const at = new Date(message.created_at).getTime();
    return isNaN(at) ? latest : Math.max(latest, at);
  }, 0);

  let lastDay = '';

  list.innerHTML = activeMessages.map((message) => {
    const isUser = message.sender === 'user';

    const day = dayKey(message.created_at);
    const heading = day && day !== lastDay
      ? `<div class="sup-day"><span>${escapeHtml(dayLabel(message.created_at))}</span></div>`
      : '';
    if (day) lastDay = day;

    const at = new Date(message.created_at).getTime();
    const seen = isUser && !isNaN(at) && lastAgentAt > at;

    return `
      ${heading}
      <div class="sup-msg ${isUser ? 'sup-msg-out' : 'sup-msg-in'}">
        <div class="sup-msg-line">
          ${isUser ? '' : '<span class="sup-avatar" aria-hidden="true">V</span>'}
          <div class="sup-bubble">${linkify(escapeHtml(message.body))}</div>
        </div>
        <div class="sup-msg-meta">
          <span>${escapeHtml(messageTime(message.created_at))}</span>
          ${isUser ? ticksHtml(seen) : ''}
        </div>
      </div>
    `;
  }).join('');
}

function renderComposer(root) {
  const isClosed = activeThread && activeThread.status === 'closed';
  root.querySelector('#supReplyRow').classList.toggle('hidden', !!isClosed);
  root.querySelector('#supClosedNotice').classList.toggle('hidden', !isClosed);
  if (isClosed) hideError(root, '#supReplyError');
  updateReplyEnabled(root);
}

function updateReplyEnabled(root) {
  const input = root.querySelector('#supReplyInput');
  const btn = root.querySelector('#supReplySendBtn');
  const isClosed = activeThread && activeThread.status === 'closed';
  btn.disabled = sendingReply || isClosed || !input.value.trim();
}

// Opening a conversation is reading it, so the dot goes when it is opened.
//
// 'answered' is the unread mark — the trigger sets it when the bank writes a
// reply — and returning the thread to 'open' is what clears it. That value is
// used rather than a new one because it is the one every version of this
// schema already accepts: a status a table forbids would fail here silently
// and leave the dot on forever.
//
// The change is made locally first. The dot belongs to the moment the thread
// opens, not to a round trip, and if the update never lands the customer has
// still read the message — the worst case is a dot that comes back on reload,
// which is honest, rather than a screen that waits to redraw itself.
async function markThreadRead(root, ctx, thread) {
  if (!thread || thread.status !== 'answered') return;

  thread.status = 'open';
  const listed = threads.find((entry) => String(entry.id) === String(thread.id));
  if (listed) listed.status = 'open';

  renderThreadsSummary(root);
  renderHistoryBadges(root);
  renderRail(root);

  try {
    if (!ctx.supabaseClient) return;
    const { error } = await ctx.supabaseClient
      .from('support_threads')
      .update({ status: 'open' })
      .eq('id', thread.id);
    if (error) throw error;
  } catch (err) {
    // Not shown to the customer: they have read the message either way, and
    // an error about a dot would be noise on top of the reply they came for.
    console.error('Support mark-read error:', err);
  }
}

async function openThread(root, ctx, thread) {
  const { supabaseClient, getCurrentUser } = ctx;
  activeThread = thread;
  activeMessages = [];
  threadOrigin = currentView(root);

  // Before the header is drawn, so the pill shows what the thread now is
  // rather than flashing 'Answered' and correcting itself.
  await markThreadRead(root, ctx, thread);

  root.querySelector('#supThreadSubject').textContent = thread.subject || '';
  const statusEl = root.querySelector('#supThreadStatus');
  statusEl.className = `sup-chat-status ${statusPillClasses(thread.status)}`;
  statusEl.textContent = statusLabel(thread.status);
  root.querySelector('#supThreadCategory').textContent = categoryLabel(thread.category);

  root.querySelector('#supReplyInput').value = '';
  hideError(root, '#supReplyError');
  hideAttachNote(root);

  // Which row the rail shows as the one being read. markThreadRead redraws it
  // too, but only for a thread that was unread — this is every thread.
  renderRail(root);

  showView(root, 'thread');
  renderComposer(root);

  try {
    const user = await getCurrentUser();
    if (user && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('support_messages')
        .select('*')
        .eq('thread_id', thread.id)
        .order('created_at', { ascending: true });
      if (error) throw error;
      activeMessages = data || [];
    }
  } catch (err) {
    console.error('Support messages error:', err);
  }

  renderMessages(root);
  scrollToNewest(root);
}

// The page container is what scrolls, so the newest message is brought into
// view by parking that container at its full height.
function scrollToNewest(root) {
  // The message list is what scrolls now, not the screen. Scrolling the screen
  // is what made writing a reply throw the whole conversation to the bottom —
  // the page moved under the header and the composer while the list stayed
  // where it was.
  const list = root.querySelector('.sup-chat-body') || root;
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}

async function sendReply(root, ctx) {
  if (sendingReply || !activeThread) return;
  const input = root.querySelector('#supReplyInput');
  const body = input.value.trim();
  if (!body || activeThread.status === 'closed') return;

  sendingReply = true;
  setBusy(root, '#supReplySendBtn', '#supReplySpinner', true);
  updateReplyEnabled(root);
  hideError(root, '#supReplyError');

  try {
    const user = await ctx.getCurrentUser();
    if (!user || !ctx.supabaseClient) throw new SupportMessageError('You need to be signed in to reply.');

    const { data, error } = await ctx.supabaseClient
      .from('support_messages')
      .insert({ thread_id: activeThread.id, user_id: user.id, sender: 'user', body })
      .select()
      .single();
    if (error) throw error;

    activeMessages = activeMessages.concat(data ? [data] : [{ sender: 'user', body, created_at: new Date().toISOString() }]);
    notifySupportInbox(ctx, activeThread.id, data && data.id);
    input.value = '';
    renderMessages(root);
    scrollToNewest(root);
  } catch (err) {
    console.error('Support reply error:', err);
    showError(root, '#supReplyError', customerFacing(err, 'Could not send your reply. Please try again.'));
  } finally {
    sendingReply = false;
    setBusy(root, '#supReplySendBtn', '#supReplySpinner', false);
    updateReplyEnabled(root);
  }
}

// ---------- View 3: New message ----------

function renderCategoryOptions(root) {
  root.querySelector('#supNewCategory').innerHTML = SUPPORT_CATEGORIES.map((entry) => `
    <option value="${escapeHtml(entry.value)}">${escapeHtml(entry.label)}</option>
  `).join('');
}

function openNew(root, options) {
  const select = root.querySelector('#supNewCategory');
  const subjectEl = root.querySelector('#supNewSubject');
  const bodyEl = root.querySelector('#supNewBody');

  // A category handed in by a topic row or by another screen is the whole
  // point of arriving here, so it survives every later render of this view.
  if (options && options.category) pendingCategory = options.category;
  const chosen = SUPPORT_CATEGORIES.some((entry) => entry.value === pendingCategory) ? pendingCategory : 'general';
  select.value = chosen;
  pendingCategory = chosen;

  if (options && typeof options.subject === 'string') subjectEl.value = options.subject.slice(0, 80);
  // A caller that knows what the request is about can write the opening line
  // too, so the form arrives ready to send rather than ready to type. Both
  // fields stay editable.
  bodyEl.value = (options && typeof options.body === 'string') ? options.body.slice(0, 2000) : '';

  hideError(root, '#supNewError');
  updateNewCount(root);
  updateNewEnabled(root);
  showView(root, 'new');
}

function updateNewCount(root) {
  const length = root.querySelector('#supNewBody').value.length;
  root.querySelector('#supNewCount').textContent = `${length} / 2000`;
}

function updateNewEnabled(root) {
  const subject = root.querySelector('#supNewSubject').value.trim();
  const body = root.querySelector('#supNewBody').value.trim();
  root.querySelector('#supNewSendBtn').disabled = sendingNew || !subject || !body;
}

async function submitNew(root, ctx) {
  // The guard, not just the disabled attribute: a second press that lands
  // between the click and the repaint must still do nothing.
  if (sendingNew) return;

  const category = root.querySelector('#supNewCategory').value;
  const subject = root.querySelector('#supNewSubject').value.trim();
  const body = root.querySelector('#supNewBody').value.trim();
  if (!subject || !body) return;

  sendingNew = true;
  updateNewEnabled(root);
  setBusy(root, '#supNewSendBtn', '#supNewSpinner', true);
  hideError(root, '#supNewError');

  try {
    const user = await ctx.getCurrentUser();
    if (!user || !ctx.supabaseClient) throw new SupportMessageError('You need to be signed in to send a message.');

    const { data: thread, error: threadError } = await ctx.supabaseClient
      .from('support_threads')
      .insert({ user_id: user.id, category, subject, status: 'open' })
      .select()
      .single();
    if (threadError) throw threadError;
    if (!thread) throw new SupportMessageError('Could not start the conversation. Please try again.');

    const { data: firstMessage, error: messageError } = await ctx.supabaseClient
      .from('support_messages')
      .insert({ thread_id: thread.id, user_id: user.id, sender: 'user', body })
      .select()
      .single();
    // A thread with no message in it is worse than no thread: opening it would
    // show an empty conversation the user believes they sent. Stay on the form
    // with the text still in it and say what happened.
    if (messageError) throw messageError;

    notifySupportInbox(ctx, thread.id, firstMessage && firstMessage.id);

    pendingCategory = '';
    await loadThreads(root, ctx);
    await openThread(root, ctx, thread);
  } catch (err) {
    console.error('Support send error:', err);
    showError(root, '#supNewError', customerFacing(err, 'Could not send your message. Please try again.'));
  } finally {
    sendingNew = false;
    setBusy(root, '#supNewSendBtn', '#supNewSpinner', false);
    updateNewEnabled(root);
  }
}

// ---------- Shared bits ----------

// The paperclip's note. Closed again whenever a thread is opened, so it is
// something the reader asked for rather than something waiting for them.
function hideAttachNote(root) {
  const note = root.querySelector('#supAttachNote');
  if (note) note.classList.add('hidden');
}

function setBusy(root, buttonSelector, spinnerSelector, busy) {
  const btn = root.querySelector(buttonSelector);
  const spinner = root.querySelector(spinnerSelector);
  if (spinner) spinner.classList.toggle('hidden', !busy);
  if (btn && busy) btn.disabled = true;
}

function showError(root, selector, message) {
  const el = root.querySelector(selector);
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
}

function hideError(root, selector) {
  const el = root.querySelector(selector);
  if (!el) return;
  el.textContent = '';
  el.classList.add('hidden');
}

export async function init(root, ctx, options) {
  // Written from the shared constant rather than trusted from the markup, so
  // the General Banking line cannot drift from the number the rest of the app
  // quotes. The Fraud & Lost Card line below it is a different number and is
  // left as it is.
  const callBtn = root.querySelector('#spCallBtn');
  const callNumber = root.querySelector('#spCallNumber');
  if (callBtn) callBtn.setAttribute('href', `tel:${SUPPORT_PHONE}`);
  if (callNumber) callNumber.textContent = SUPPORT_PHONE_DISPLAY;

  // Same treatment for the mailbox: one constant, so this screen cannot come
  // to quote a different address from the footer or the function that sends.
  const emailBtn = root.querySelector('#spEmailBtn');
  const emailAddress = root.querySelector('#spEmailAddress');
  if (emailBtn) emailBtn.setAttribute('href', `mailto:${SUPPORT_EMAIL}`);
  if (emailAddress) emailAddress.textContent = SUPPORT_EMAIL;

  threads = [];
  latestByThread = {};
  activeThread = null;
  activeMessages = [];
  threadOrigin = 'list';
  topicFilter = '';
  pendingCategory = (options && options.category) || '';
  sendingNew = false;
  sendingReply = false;

  renderCategoryOptions(root);
  renderTopics(root);

  // Two of them now: the home screen's arrow, and the chat box's exit. A
  // querySelector would have wired the first and left the other dead.
  root.querySelectorAll('[data-action="close"]').forEach((btn) => on(btn, 'click', ctx.close));

  // The thread and compose views back out to the list; the list backs out to
  // the home screen.
  root.querySelectorAll('[data-action="sup-back"]').forEach((btn) => {
    on(btn, 'click', () => {
      // Back goes where this conversation was opened from. Opened from a send,
      // that is the home screen; opened from the list, the list. The history
      // button beside it is the one that always means "my conversations", so
      // the two are not the same press twice.
      const back = threadOrigin === 'list' ? 'list' : 'home';
      showView(root, back);
      loadThreads(root, ctx);
    });
  });

  root.querySelectorAll('[data-action="sup-home"]').forEach((btn) => {
    on(btn, 'click', () => showView(root, 'home'));
  });

  // The compose screen is opened from the home screen and from topic rows, so
  // its arrow goes back there. It used to land on the message list, which is
  // somewhere the reader had not been.
  root.querySelectorAll('[data-action="sup-back-home"]').forEach((btn) => {
    on(btn, 'click', () => showView(root, 'home'));
  });

  // One button, the same on every screen, that opens the conversation history.
  // Reaching it used to mean pressing back the right number of times and
  // knowing where that would land.
  root.querySelectorAll('[data-action="sup-history"]').forEach((btn) => {
    on(btn, 'click', () => {
      showView(root, 'list');
      loadThreads(root, ctx);
    });
  });

  on(root.querySelector('#supThreadsRow'), 'click', () => {
    showView(root, 'list');
    loadThreads(root, ctx);
  });

  on(root.querySelector('#supSearch'), 'input', (e) => {
    topicFilter = e.target.value;
    renderTopics(root);
  });

  // Delegated, because the rows are rebuilt every time the search changes.
  // Delegated on both lists, because the rows are rebuilt on every search.
  // A funding row opens the message already written, the way the Fund account
  // screen does; the others open the form with the category chosen and the
  // subject filled in, and leave the writing to the customer.
  const openTopic = (e) => {
    const row = e.target.closest('.sup-topic');
    if (!row) return;
    const label = row.getAttribute('data-label');
    const topic = SUPPORT_TOPICS.find((entry) => entry.label === label);
    if (!topic) return;
    ctx.openSupportMessage({
      category: topic.category,
      subject: topic.subject || topic.label,
      ...(topic.body ? { body: topic.body } : {}),
    });
  };
  on(root.querySelector('#supTopics'), 'click', openTopic);
  on(root.querySelector('#supFunding'), 'click', openTopic);

  on(root.querySelector('#supNewMsgBtn'), 'click', () => ctx.openSupportMessage({ category: 'general' }));
  on(root.querySelector('#supClosedNewBtn'), 'click', () => openNew(root, { category: activeThread ? activeThread.category : '' }));

  on(root.querySelector('#supNewSubject'), 'input', () => updateNewEnabled(root));
  on(root.querySelector('#supNewBody'), 'input', () => { updateNewCount(root); updateNewEnabled(root); });
  on(root.querySelector('#supNewCategory'), 'change', (e) => { pendingCategory = e.target.value; });
  on(root.querySelector('#supNewSendBtn'), 'click', () => submitNew(root, ctx));

  on(root.querySelector('#supReplyInput'), 'input', () => updateReplyEnabled(root));
  on(root.querySelector('#supReplyInput'), 'keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendReply(root, ctx); }
  });
  on(root.querySelector('#supReplySendBtn'), 'click', () => sendReply(root, ctx));

  // The rail. One handler on the container rather than one per row, because
  // the rows are rebuilt every time a conversation is opened.
  on(root.querySelector('#supRailList'), 'click', (e) => {
    const row = e.target.closest('.sup-rail-row');
    if (!row) return;
    const thread = threads.find((entry) => String(entry.id) === row.getAttribute('data-id'));
    if (thread && (!activeThread || String(activeThread.id) !== String(thread.id))) openThread(root, ctx, thread);
  });

  on(root.querySelector('#supRailNewBtn'), 'click', () => ctx.openSupportMessage({ category: 'general' }));

  // Documents are not carried by support_messages, and adding a picker that
  // led nowhere would be worse than the paperclip not being there at all. It
  // says where a document does go instead — the same mailbox the home screen
  // and the send function quote, from the same constant.
  const attachNote = root.querySelector('#supAttachNote');
  if (attachNote) attachNote.textContent = `To send a document, email it to ${SUPPORT_EMAIL} and mention this conversation.`;
  on(root.querySelector('#supAttachBtn'), 'click', () => {
    if (attachNote) attachNote.classList.toggle('hidden');
  });

  if (options && options.view === 'new') {
    openNew(root, options);
    loadThreads(root, ctx);
    return;
  }

  showView(root, 'home');
  await loadThreads(root, ctx);

  // Deep link straight to one conversation — a support notification names the
  // thread it is about, and landing on the list instead would make the reader
  // hunt for it.
  if (options && options.view === 'thread' && options.threadId) {
    const target = threads.find((entry) => String(entry.id) === String(options.threadId));
    if (target) await openThread(root, ctx, target);
  }
}

export function cleanup() {
  listeners.forEach((off) => off());
  listeners = [];
  threads = [];
  latestByThread = {};
  activeThread = null;
  activeMessages = [];
  topicFilter = '';
  pendingCategory = '';
  sendingNew = false;
  sendingReply = false;
}
