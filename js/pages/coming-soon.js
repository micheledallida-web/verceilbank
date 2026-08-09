// Shared placeholder for entries whose destination screen has not been built
// yet. A menu row that does nothing when tapped reads as broken, so every such
// row lands here instead — with the row's own label in the title bar, so it is
// obvious which feature is being waited on.

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
  const { loadPage } = ctx;

  if (title) root.querySelector('#csTitle').textContent = title;

  // Every entry that reaches this screen comes from the Profile sheet, so back
  // returns there rather than to the dashboard.
  root.querySelectorAll('[data-action="back"]').forEach((btn) => on(btn, 'click', () => loadPage('profile')));

  root.querySelector('#csBody').innerHTML = emptyState('Coming soon<br>This feature is being finalised.');
}

export function cleanup() {
  listeners.forEach((off) => off());
  listeners = [];
}
