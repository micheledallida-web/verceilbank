// Shared placeholder for entries whose destination screen has not been built
// yet. A row that does nothing when tapped reads as broken, so every such row
// lands here instead — with its own label in the title bar, so it is obvious
// which feature is being waited on.

let listeners = [];

function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}

// The same empty-state card the rest of the app uses for a section with
// nothing in it yet.
function emptyState(message) {
  return `<div class="bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[14px] px-[16px] py-3 shadow-lg text-center text-[12px] text-[#6B7280] dark:text-[#8E9CBA]">${message}</div>`;
}

export function init(root, ctx, title) {
  const { close } = ctx;

  if (title) root.querySelector('#csTitle').textContent = title;

  // Closes back to whatever was underneath, since this is reached from both the
  // Profile sheet and the quick actions panel.
  root.querySelectorAll('[data-action="back"]').forEach((btn) => on(btn, 'click', close));

  root.querySelector('#csBody').innerHTML = emptyState('Coming soon<br>This feature is being finalised.');
}

export function cleanup() {
  listeners.forEach((off) => off());
  listeners = [];
}
