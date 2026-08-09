let listeners = [];
function on(el, evt, fn) { if (!el) return; el.addEventListener(evt, fn); listeners.push(() => el.removeEventListener(evt, fn)); }

export function init(root, ctx) {
  const { close } = ctx;

  on(root.querySelector('[data-action="close"]'), 'click', close);
}

export function cleanup() {
  listeners.forEach(off => off());
  listeners = [];
}
