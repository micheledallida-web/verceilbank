// Support tab. Three views live in the one fragment — the home list, a thread,
// and the new-message form — because they share one back stack and swapping a
// hidden class is cheaper than tearing the page down and refetching on every
// hop between them.

// The categories the support_threads table accepts, paired with something a
// person would actually recognise. This is the only place the mapping lives.
const SUPPORT_CATEGORIES = [
  { value: 'general', label: 'General' },
  { value: 'card_application', label: 'Card application' },
  { value: 'funding_zelle', label: 'Funding — Zelle' },
  { value: 'funding_cashapp', label: 'Funding — Cash App' },
  { value: 'funding_paypal', label: 'Funding — PayPal' },
  { value: 'funding_ach', label: 'Funding — ACH transfer' },
  { value: 'disputes', label: 'Disputes' },
  { value: 'account_access', label: 'Account access' },
];

// Each tile is a shortcut into the new-message form with the category already
// chosen, so the common cases never make anyone read the category list.
const SUPPORT_TOPICS = [
  { label: 'Cards & PINs', category: 'card_application' },
  { label: 'Disputes', category: 'disputes' },
  { label: 'Transfers', category: 'funding_ach' },
  { label: 'Statements', category: 'general' },
  { label: 'Account access', category: 'account_access' },
  { label: 'Fees', category: 'general' },
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

function emptyState(message) {
  return `<div class="bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[14px] px-[16px] py-3 shadow-lg text-center text-[12px] text-[#6B7280] dark:text-[#8E9CBA]">${message}</div>`;
}

// ---------- View switching ----------

function showView(root, name) {
  root.querySelector('#supHomeView').classList.toggle('hidden', name !== 'home');
  root.querySelector('#supThreadView').classList.toggle('hidden', name !== 'thread');
  root.querySelector('#supNewView').classList.toggle('hidden', name !== 'new');
  // The composer belongs to the thread view but is positioned against the
  // screen, so it lives outside that container and is toggled alongside it.
  root.querySelector('#supComposer').classList.toggle('hidden', name !== 'thread');
  if (name !== 'thread') root.scrollTop = 0;
}

// ---------- View 1: Support home ----------

function renderTopics(root) {
  const grid = root.querySelector('#supTopics');
  const empty = root.querySelector('#supTopicsEmpty');
  const needle = topicFilter.trim().toLowerCase();
  const matches = needle
    ? SUPPORT_TOPICS.filter((topic) => topic.label.toLowerCase().includes(needle))
    : SUPPORT_TOPICS;

  grid.innerHTML = matches.map((topic) => `
    <button class="sup-topic bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[16px] p-[14px] shadow-lg text-left cursor-pointer" data-category="${escapeHtml(topic.category)}">
      <span class="block text-[13px] font-semibold text-[#111827] dark:text-white">${escapeHtml(topic.label)}</span>
    </button>
  `).join('');

  grid.classList.toggle('hidden', !matches.length);
  empty.classList.toggle('hidden', !!matches.length);
}

function renderThreads(root) {
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
      if (thread) openThread(root, currentCtx, thread);
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
      renderThreads(root);
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

  renderThreads(root);
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

async function openThread(root, ctx, thread) {
  const { supabaseClient, getCurrentUser } = ctx;
  activeThread = thread;
  activeMessages = [];

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
    if (!user || !ctx.supabaseClient) throw new Error('You need to be signed in to reply.');

    const { data, error } = await ctx.supabaseClient
      .from('support_messages')
      .insert({ thread_id: activeThread.id, user_id: user.id, sender: 'user', body })
      .select()
      .single();
    if (error) throw error;

    activeMessages = activeMessages.concat(data ? [data] : [{ sender: 'user', body, created_at: new Date().toISOString() }]);
    input.value = '';
    renderMessages(root);
    scrollToNewest(root);
  } catch (err) {
    console.error('Support reply error:', err);
    showError(root, '#supReplyError', err && err.message ? err.message : 'Could not send your reply. Please try again.');
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

  // A category handed in by a topic tile or by another screen is the whole
  // point of arriving here, so it survives every later render of this view.
  if (options && options.category) pendingCategory = options.category;
  const chosen = SUPPORT_CATEGORIES.some((entry) => entry.value === pendingCategory) ? pendingCategory : 'general';
  select.value = chosen;
  pendingCategory = chosen;

  if (options && typeof options.subject === 'string') subjectEl.value = options.subject.slice(0, 80);
  bodyEl.value = '';

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
    if (!user || !ctx.supabaseClient) throw new Error('You need to be signed in to send a message.');

    const { data: thread, error: threadError } = await ctx.supabaseClient
      .from('support_threads')
      .insert({ user_id: user.id, category, subject, status: 'open' })
      .select()
      .single();
    if (threadError) throw threadError;
    if (!thread) throw new Error('Could not start the conversation. Please try again.');

    const { error: messageError } = await ctx.supabaseClient
      .from('support_messages')
      .insert({ thread_id: thread.id, user_id: user.id, sender: 'user', body });
    // A thread with no message in it is worse than no thread: opening it would
    // show an empty conversation the user believes they sent. Stay on the form
    // with the text still in it and say what happened.
    if (messageError) throw messageError;

    pendingCategory = '';
    await loadThreads(root, ctx);
    await openThread(root, ctx, thread);
  } catch (err) {
    console.error('Support send error:', err);
    showError(root, '#supNewError', err && err.message ? err.message : 'Could not send your message. Please try again.');
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

// Thread rows are re-rendered on every refresh, so their click handler needs
// the context that was handed to init().
let currentCtx = null;

export async function init(root, ctx, options) {
  currentCtx = ctx;
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

  // Both inner views back out to the home list rather than off the page.
  root.querySelectorAll('[data-action="sup-back"]').forEach((btn) => {
    on(btn, 'click', () => {
      showView(root, 'home');
      loadThreads(root, ctx);
    });
  });

  on(root.querySelector('#supSearch'), 'input', (e) => {
    topicFilter = e.target.value;
    renderTopics(root);
  });

  // Delegated, because the tiles are rebuilt every time the search changes.
  on(root.querySelector('#supTopics'), 'click', (e) => {
    const tile = e.target.closest('.sup-topic');
    if (!tile) return;
    openNew(root, { category: tile.getAttribute('data-category') });
  });

  on(root.querySelector('#supNewMsgBtn'), 'click', () => openNew(root, { category: '' }));
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
  // hunt for it. The list is loaded either way, so backing out lands somewhere
  // real rather than on an empty screen.
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
  currentCtx = null;
}
