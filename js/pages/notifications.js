// Notifications. This was a dropdown anchored under the bell, which meant every
// notification had to fit a 260px box — so the body text was clipped mid
// sentence and there was nowhere to read the rest. A notification is the one
// thing in the app that must be readable in full, so it gets the whole screen
// and its body wraps to as many lines as it needs.

import { watchRealtime } from '../shared/activity.js';

let listeners = [];
let items = [];
let channel = null;
let channelClient = null;

function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}

// Titles and bodies are stored text going back out into innerHTML.
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// Whole days apart, so something that landed at 11pm last night reads as
// Yesterday this morning rather than as Today.
function dayBucket(value) {
  const date = new Date(value);
  if (isNaN(date)) return 'earlier';
  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return 'earlier';
}

// A time for today, a date for anything older — the day is what you need for
// an old one, the hour is what you need for a new one.
function rowTime(value) {
  const date = new Date(value);
  if (isNaN(date)) return '';
  if (dayBucket(value) === 'today') {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function unreadCount() {
  return items.filter((item) => !item.is_read).length;
}

function sectionLabel(text) {
  return `<div class="text-[11px] font-bold tracking-[1.2px] text-white/75 dark:text-[#8E9CBA] uppercase mt-[6px] mb-[2px]">${text}</div>`;
}

function renderRow(item) {
  const isUnread = !item.is_read;
  // The dot's slot is always present so titles line up whether or not a row
  // is unread; only its colour changes.
  return `
    <button class="ntf-row w-full ${isUnread ? 'bg-blue-50 dark:bg-white/5' : 'bg-white dark:bg-[#0D1728]'} border border-transparent dark:border-white/[0.06] rounded-[16px] p-[14px] shadow-lg text-left cursor-pointer" data-id="${escapeHtml(item.id)}">
      <div class="flex items-start gap-[10px]">
        <span class="w-[8px] h-[8px] rounded-full flex-shrink-0 mt-[6px] ${isUnread ? 'bg-[#2563EB]' : 'bg-transparent'}"></span>
        <div class="min-w-0 flex-1">
          <div class="flex items-start justify-between gap-[12px]">
            <span class="text-[13px] font-bold text-[#111827] dark:text-white break-words">${escapeHtml(item.title)}</span>
            <span class="text-[11px] text-[#6B7280] dark:text-[#8E9CBA] flex-shrink-0">${escapeHtml(rowTime(item.created_at))}</span>
          </div>
          <div class="text-[12px] text-[#6B7280] dark:text-[#8E9CBA] mt-[3px] break-words whitespace-pre-wrap">${escapeHtml(item.body)}</div>
        </div>
      </div>
    </button>
  `;
}

function renderEmpty() {
  return `
    <div class="bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[16px] px-[16px] py-6 shadow-lg text-center">
      <span class="w-[48px] h-[48px] rounded-full bg-blue-50 dark:bg-white/5 flex items-center justify-center mx-auto mb-[12px]">
        <svg class="w-[22px] h-[22px] text-[#2563EB]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.7 21a2 2 0 01-3.4 0"></path></svg>
      </span>
      <div class="text-[13px] font-semibold text-[#111827] dark:text-white">You're all caught up</div>
      <div class="text-[12px] text-[#6B7280] dark:text-[#8E9CBA] mt-[4px]">New alerts about your accounts will appear here.</div>
    </div>
  `;
}

function render(root, ctx) {
  const list = root.querySelector('#ntfList');
  const markAllBtn = root.querySelector('#ntfMarkAllBtn');

  markAllBtn.classList.toggle('hidden', unreadCount() === 0);

  if (!items.length) {
    list.innerHTML = renderEmpty();
    return;
  }

  const buckets = { today: [], yesterday: [], earlier: [] };
  items.forEach((item) => { buckets[dayBucket(item.created_at)].push(item); });

  // A heading with nothing under it is noise, so each one is only emitted
  // when its bucket caught something.
  let html = '';
  if (buckets.today.length) html += sectionLabel('TODAY') + buckets.today.map(renderRow).join('');
  if (buckets.yesterday.length) html += sectionLabel('YESTERDAY') + buckets.yesterday.map(renderRow).join('');
  if (buckets.earlier.length) html += sectionLabel('EARLIER') + buckets.earlier.map(renderRow).join('');
  list.innerHTML = html;

  list.querySelectorAll('.ntf-row').forEach((btn) => {
    on(btn, 'click', () => {
      const item = items.find((entry) => String(entry.id) === btn.getAttribute('data-id'));
      if (item) openNotification(root, ctx, item);
    });
  });
}

async function loadNotifications(root, ctx) {
  const { supabaseClient, getCurrentUser } = ctx;
  items = [];
  try {
    const user = await getCurrentUser();
    if (user && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('notifications')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      items = data || [];
    }
  } catch (err) {
    console.error('Notifications load error:', err);
  }
  render(root, ctx);
}

// Reading is the first thing that happens and it happens locally, so the dot
// clears on tap rather than after a round trip. The write follows; if it
// fails the next load will show the row unread again, which is the honest
// outcome.
async function markRead(ctx, item) {
  if (item.is_read) return;
  item.is_read = true;
  try {
    const user = await ctx.getCurrentUser();
    if (!user || !ctx.supabaseClient) return;
    const { error } = await ctx.supabaseClient
      .from('notifications')
      .update({ is_read: true })
      .eq('id', item.id)
      .eq('user_id', user.id);
    if (error) throw error;
  } catch (err) {
    console.error('Notification mark read error:', err);
  }
}

async function openNotification(root, ctx, item) {
  await markRead(ctx, item);
  render(root, ctx);
  if (ctx.refreshAlertsBadge) ctx.refreshAlertsBadge();

  // A notification with no link is a statement of fact, not a doorway: it
  // marks itself read and leaves you where you are.
  switch (item.link_type) {
    case 'account':
      if (item.link_id) ctx.loadPage('account-detail', item.link_id);
      break;
    case 'document':
      ctx.loadPage('docs-hub');
      break;
    case 'support':
      if (item.link_id) ctx.loadPage('support', { view: 'thread', threadId: item.link_id });
      break;
    default:
      break;
  }
}

async function markAllRead(root, ctx) {
  if (!unreadCount()) return;
  items.forEach((item) => { item.is_read = true; });
  render(root, ctx);

  try {
    const user = await ctx.getCurrentUser();
    if (!user || !ctx.supabaseClient) return;
    const { error } = await ctx.supabaseClient
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', user.id)
      .eq('is_read', false);
    if (error) throw error;
  } catch (err) {
    console.error('Notifications mark all read error:', err);
  }

  if (ctx.refreshAlertsBadge) ctx.refreshAlertsBadge();
}

// ---------- Realtime ----------

function teardownChannel() {
  // `channel` is now the unsubscribe function watchRealtime returns, which
  // also stops any pending reconnect — a retry timer left running after the
  // view closed would reopen a channel nothing is listening to.
  if (typeof channel === 'function') {
    try { channel(); } catch (err) {}
  } else if (channel && channelClient) {
    try { channelClient.removeChannel(channel); } catch (err) {}
  }
  channel = null;
  channelClient = null;
}

async function subscribeToInserts(root, ctx) {
  const { supabaseClient, getCurrentUser } = ctx;
  if (!supabaseClient) return;

  // Opening the view twice must not leave two channels running against the
  // same table — the previous one goes before a new one is made.
  teardownChannel();

  const user = await getCurrentUser();
  if (!user) return;

  channelClient = supabaseClient;
  channel = watchRealtime((client) => client
    .channel(`notifications:${user.id}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'notifications',
      // Scoped to this user. Without the filter every account holder's
      // notifications would arrive here.
      filter: `user_id=eq.${user.id}`,
    }, (payload) => {
      if (!payload.new) return;
      if (items.some((item) => String(item.id) === String(payload.new.id))) return;
      items = [payload.new].concat(items);
      render(root, ctx);
      if (ctx.refreshAlertsBadge) ctx.refreshAlertsBadge();
    }),
  'notifications');
}

export async function init(root, ctx) {
  items = [];

  on(root.querySelector('[data-action="close"]'), 'click', ctx.close);
  on(root.querySelector('#ntfMarkAllBtn'), 'click', () => markAllRead(root, ctx));

  await loadNotifications(root, ctx);
  subscribeToInserts(root, ctx);
}

export function cleanup() {
  teardownChannel();
  listeners.forEach((off) => off());
  listeners = [];
  items = [];
}
