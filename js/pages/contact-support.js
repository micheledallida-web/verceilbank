import { SUPPORT_PHONE, SUPPORT_PHONE_DISPLAY } from '../shared/account-products.js';

let listeners = [];
function on(el, evt, fn) { if (!el) return; el.addEventListener(evt, fn); listeners.push(() => el.removeEventListener(evt, fn)); }

export function init(root, ctx) {
  const { close } = ctx;

  on(root.querySelector('[data-action="close"]'), 'click', close);

  // The number in the markup is a fallback. It is written from the shared
  // constant here so this screen cannot end up quoting a number the rest of
  // the app has stopped using — which is exactly what had happened.
  const callBtn = root.querySelector('#csCallBtn');
  const callNumber = root.querySelector('#csCallNumber');
  if (callBtn) callBtn.setAttribute('href', `tel:${SUPPORT_PHONE}`);
  if (callNumber) callNumber.textContent = SUPPORT_PHONE_DISPLAY;
}

export function cleanup() {
  listeners.forEach(off => off());
  listeners = [];
}
