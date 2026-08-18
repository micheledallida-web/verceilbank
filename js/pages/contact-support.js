import { SUPPORT_PHONE, SUPPORT_PHONE_DISPLAY, SUPPORT_EMAIL } from '../shared/account-products.js';

let listeners = [];
function on(el, evt, fn) { if (!el) return; el.addEventListener(evt, fn); listeners.push(() => el.removeEventListener(evt, fn)); }

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

  // Messaging hands off to the Support tab's compose form rather than writing
  // to the database here: one screen owning that means one place where a failed
  // send is handled, and one place to fix when it changes.
  if (openSupportMessage) {
    on(root.querySelector('#csMessageBtn'), 'click', () => openSupportMessage({ category: 'general' }));
  }
}

export function cleanup() {
  listeners.forEach(off => off());
  listeners = [];
}
