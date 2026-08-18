// Support tab. Four views live in the one fragment — the home screen, the
// message list, a thread, and the new-message form — because they share one
// back stack and swapping a hidden class is cheaper than tearing the page down
// and refetching on every hop between them.

import { SUPPORT_PHONE, SUPPORT_PHONE_DISPLAY } from '../shared/account-products.js';

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

// Each topic is a shortcut into the new-message form with the category and
// subject already filled in, so the common cases never make anyone read the
// category list. Icons are stroke SVGs matching the rest of the app.
const SUPPORT_TOPICS = [
  {
    label: 'Cards & PINs',
    category: 'card_application',
    icon: '<rect x="2" y="5" width="20" height="14" rx="3"></rect><path d="M2 10h20"></path><path d="M6 15h4"></path>',
  },
  {
    label: 'Disputes',
    category: 'disputes',
    icon: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path>',
  },
  {
    label: 'Transfers',
    category: 'funding_ach',
    icon: '<path d="M7 7h11m0 0-4-4m4 4-4 4"></path><path d="M17 17H6m0 0 4 4m-4-4 4-4"></path>',
  },
  {
    label: 'Statements',
    category: 'general',
    icon: '<path d="M6 3h9l3 3v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"></path><path d="M9 9h6M9 13h6M9 17h4"></path>',
  },
  {
    label: 'Account access',
    category: 'account_access',
    icon: '<rect x="4" y="10" width="16" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path>',
  },
  {
    label: 'Fees',
    category: 'general',
    icon: '<path d="M19 5 5 19"></path><circle cx="7.5" cy="7.5" r="2.5"></circle><circle cx="16.5" cy="16.5" r="2.5"></circle>',
  },
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

function messageTimestamp(value) {
  if (!value) return '';
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
function notifySupportInbox(ctx, threadId, messageId) {
  if (!ctx.supabaseClient || !ctx.supabaseClient.functions || !threadId || !messageId) return;
  ctx.supabaseClient.functions
    .invoke('support-notify', { body: { thread_id: threadId, message_id: messageId } })
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
function renderTopics(root) {
  const list = root.querySelector('#supTopics');
  const empty = root.querySelector('#supTopicsEmpty');
  const needle = topicFilter.trim().toLowerCase();
  const matches = needle
    ? SUPPORT_TOPICS.filter((topic) => topic.label.toLowerCase().includes(needle))
    : SUPPORT_TOPICS;

  list.innerHTML = matches.map((topic) => `
    <button type="button" class="sup-topic w-full flex items-center gap-[12px] px-[12px] py-[14px] text-left cursor-pointer border-b border-white/15 dark:border-white/[0.08]" data-label="${escapeHtml(topic.label)}">
      <svg class="w-[20px] h-[20px] text-white/80 dark:text-[#8E9CBA] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${topic.icon}</svg>
      <span class="flex-1 min-w-0 text-[15px] font-medium text-white truncate">${escapeHtml(topic.label)}</span>
      <svg class="w-[16px] h-[16px] text-white/60 dark:text-[#52607D] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
    </button>
  `).join('');

  list.classList.toggle('hidden', !matches.length);
  empty.classList.toggle('hidden', !!matches.length);
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
}

// ---------- View 2: Thread detail ----------

function renderMessages(root) {
  root.querySelector('#supMessages').innerHTML = activeMessages.length
    ? activeMessages.map((message) => {
      const isUser = message.sender === 'user';
      return `
        <div class="flex flex-col ${isUser ? 'items-end' : 'items-start'}">
          <div class="max-w-[75%] px-[12px] py-[8px] rounded-[12px] text-[13px] ${isUser ? 'bg-[#2563EB] text-white' : 'bg-white dark:bg-[#0D1728] text-[#111827] dark:text-white'}">${escapeHtml(message.body)}</div>
          <span class="text-[10px] text-white/70 dark:text-[#8E9CBA] mt-[3px] px-[2px]">${escapeHtml(messageTimestamp(message.created_at))}</span>
        </div>
      `;
    }).join('')
    : emptyState('No messages in this conversation yet.');
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

  // Before the header is drawn, so the pill shows what the thread now is
  // rather than flashing 'Answered' and correcting itself.
  await markThreadRead(root, ctx, thread);

  root.querySelector('#supThreadSubject').textContent = thread.subject || '';
  const statusEl = root.querySelector('#supThreadStatus');
  statusEl.className = `inline-flex items-center px-[8px] h-[20px] rounded-full text-[10px] font-bold ${statusPillClasses(thread.status)}`;
  statusEl.textContent = statusLabel(thread.status);
  root.querySelector('#supThreadCategory').textContent = categoryLabel(thread.category);

  root.querySelector('#supReplyInput').value = '';
  hideError(root, '#supReplyError');

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
  requestAnimationFrame(() => { root.scrollTop = root.scrollHeight; });
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

  threads = [];
  latestByThread = {};
  activeThread = null;
  activeMessages = [];
  topicFilter = '';
  pendingCategory = (options && options.category) || '';
  sendingNew = false;
  sendingReply = false;

  renderCategoryOptions(root);
  renderTopics(root);

  on(root.querySelector('[data-action="close"]'), 'click', ctx.close);

  // The thread and compose views back out to the list; the list backs out to
  // the home screen.
  root.querySelectorAll('[data-action="sup-back"]').forEach((btn) => {
    on(btn, 'click', () => {
      showView(root, 'list');
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
  on(root.querySelector('#supTopics'), 'click', (e) => {
    const row = e.target.closest('.sup-topic');
    if (!row) return;
    const label = row.getAttribute('data-label');
    const topic = SUPPORT_TOPICS.find((entry) => entry.label === label);
    if (!topic) return;
    ctx.openSupportMessage({ category: topic.category, subject: topic.label });
  });

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
