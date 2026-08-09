let listeners = [];
function on(el, evt, fn) { if (!el) return; el.addEventListener(evt, fn); listeners.push(() => el.removeEventListener(evt, fn)); }

let activeHelpCat = 'all';

export function init(root, ctx) {
  const { showModal, loadPage, close } = ctx;
  const helpSearch = root.querySelector('#helpSearch');
  const helpTopicsList = root.querySelector('#helpTopicsList');

  const helpTopics = [
    { title: 'Reset Password', cat: 'Security', action: () => showModal('Reset Password', 'Contact Support to reset your password.') },
    { title: 'Lock Card', cat: 'Cards', action: () => loadPage('card-services') },
    { title: 'Wire Transfer Help', cat: 'Payments', action: () => showModal('Wire Transfer Help', 'Wire transfers are found under Payments → Wire Transfers. Domestic wires typically settle same-day; international wires take 1–3 business days.') },
    { title: 'Zelle Questions', cat: 'Payments', action: () => showModal('Zelle® Questions', 'Send Money (Zelle®) is found under Payments → Send Money. Payments are typically instant to enrolled recipients.') },
    { title: 'Investment Statements', cat: 'Accounts', action: () => showModal('Investment Statements', 'Investment statements are available from the Statements screen. If you need immediate help locating one, contact support.') },
    { title: 'Fraud Protection', cat: 'Security', action: () => loadPage('report-card') },
  ];

  function paintCategoryChips() {
    root.querySelectorAll('.help-cat-chip').forEach(btn => {
      const active = btn.getAttribute('data-cat') === activeHelpCat;
      btn.classList.toggle('bg-[#2563EB]', active);
      btn.classList.toggle('text-white', active);
      btn.classList.toggle('bg-white', !active);
      btn.classList.toggle('dark:bg-[#0D1728]', !active);
      btn.classList.toggle('text-[#111827]', !active);
      btn.classList.toggle('dark:text-white', !active);
    });
  }

  function renderHelpTopics() {
    const query = helpSearch.value.trim().toLowerCase();
    const filtered = helpTopics.filter(t => (activeHelpCat === 'all' || t.cat === activeHelpCat) && t.title.toLowerCase().includes(query));
    if (filtered.length === 0) {
      helpTopicsList.innerHTML = '<div class="bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[16px] px-[16px] shadow-lg py-4"><div class="text-center text-[13px] text-[#6B7280] dark:text-[#8E9CBA] py-2">No matching topics.</div></div>';
      return;
    }
    helpTopicsList.innerHTML = filtered.map((t, idx) => `
      <button class="help-topic-item w-full bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[14px] p-[13px] shadow-lg flex items-center justify-between text-left cursor-pointer" data-idx="${idx}">
        <span class="text-[13px] font-semibold text-[#111827] dark:text-white">${t.title}</span>
        <svg class="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
      </button>
    `).join('');
    root.querySelectorAll('.help-topic-item').forEach(btn => {
      on(btn, 'click', () => filtered[parseInt(btn.getAttribute('data-idx'), 10)].action());
    });
  }

  on(root.querySelector('[data-action="close"]'), 'click', close);
  on(helpSearch, 'input', renderHelpTopics);
  root.querySelectorAll('.help-cat-chip').forEach(btn => {
    on(btn, 'click', () => {
      activeHelpCat = btn.getAttribute('data-cat') || 'all';
      paintCategoryChips();
      renderHelpTopics();
    });
  });
  on(root.querySelector('#helpApptBtn'), 'click', () => loadPage('contact-support'));

  paintCategoryChips();
  renderHelpTopics();
}

export function cleanup() {
  listeners.forEach(off => off());
  listeners = [];
  activeHelpCat = 'all';
}
