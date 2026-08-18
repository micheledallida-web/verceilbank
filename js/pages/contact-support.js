import { SUPPORT_PHONE, SUPPORT_PHONE_DISPLAY, SUPPORT_EMAIL } from '../shared/account-products.js';
import { SUPPORT_TOPICS } from '../shared/support-topics.js';

let listeners = [];
function on(el, evt, fn) { if (!el) return; el.addEventListener(evt, fn); listeners.push(() => el.removeEventListener(evt, fn)); }

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Everything except funding. Somebody reaches this screen from the help pages,
// not from the place money is moved, so "send me your Zelle details" is not a
// question being asked here — and the funding flow is where those rows earn
// their place.
const INQUIRIES = SUPPORT_TOPICS.filter((topic) => topic.group !== 'funding');

function renderInquiries(root) {
  const list = root.querySelector('#csInquiries');
  if (!list) return;
  list.innerHTML = INQUIRIES.map((topic) => `
    <button type="button" class="cs-inquiry w-full bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[16px] p-[14px] shadow-lg flex items-center justify-between gap-[10px] cursor-pointer text-left" data-label="${escapeHtml(topic.label)}">
      <span class="flex items-center gap-[10px] min-w-0 text-[14px] font-semibold text-[#111827] dark:text-white">
        <svg class="w-[18px] h-[18px] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${topic.icon}</svg>
        <span class="truncate">${escapeHtml(topic.label)}</span>
      </span>
      <svg class="w-[16px] h-[16px] text-[#6B7280] dark:text-[#52607D] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
    </button>
  `).join('');
}

export function init(root, ctx) {
  const { close, openSupportMessage } = ctx;

  on(root.querySelector('[data-action="close"]'), 'click', close);

  // The number in the markup is a fallback. It is written from the shared
  // constant here so this screen cannot end up quoting a number the rest of
  // the app has stopped using — which is exactly what had happened.
  const callBtn = root.querySelector('#csCallBtn');
  const callNumber = root.querySelector('#csCallNumber');
  if (callBtn) callBtn.setAttribute('href', `tel:${SUPPORT_PHONE}`);
  if (callNumber) callNumber.textContent = SUPPORT_PHONE_DISPLAY;

  // Same reasoning for the mailbox.
  const emailBtn = root.querySelector('#csEmailBtn');
  const emailAddress = root.querySelector('#csEmailAddress');
  if (emailBtn) emailBtn.setAttribute('href', `mailto:${SUPPORT_EMAIL}`);
  if (emailAddress) emailAddress.textContent = SUPPORT_EMAIL;

  renderInquiries(root);

  // Both of these hand off to the Support tab's compose form. This screen does
  // not write to the database itself: one screen owning that means one place
  // where a failed send is handled, and one place to fix when it changes.
  if (openSupportMessage) {
    on(root.querySelector('#csMessageBtn'), 'click', () => openSupportMessage({ category: 'general' }));

    // Delegated, so a row added to the shared list needs nothing here.
    on(root.querySelector('#csInquiries'), 'click', (e) => {
      const row = e.target.closest('.cs-inquiry');
      if (!row) return;
      const topic = INQUIRIES.find((entry) => entry.label === row.getAttribute('data-label'));
      if (!topic) return;
      openSupportMessage({
        category: topic.category,
        subject: topic.subject || topic.label,
        ...(topic.body ? { body: topic.body } : {}),
      });
    });
  }
}

export function cleanup() {
  listeners.forEach(off => off());
  listeners = [];
}
