const balanceSourceIds = { checking: 'checkingBalance', savings: 'savingsBalance', investments: 'investmentsBalance' };
const docTypeLabels = {
  monthly_statement: 'Monthly Statement',
  account_document: 'Account Document',
  confirmation_notice: 'Confirmation Notice',
};

let listeners = [];
let activeTab = 'checking';
let activeDocFilter = 'all';
let currentDocs = [];

function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}

function normalizeDocType(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function setActiveClasses(root) {
  root.querySelectorAll('.adh-tab').forEach((btn) => {
    const active = btn.getAttribute('data-tab') === activeTab;
    btn.classList.toggle('bg-[#2563EB]', active);
    btn.classList.toggle('text-white', active);
    btn.classList.toggle('bg-white', !active);
    btn.classList.toggle('dark:bg-[#0D1728]', !active);
    btn.classList.toggle('text-[#111827]', !active);
    btn.classList.toggle('dark:text-white', !active);
  });
  root.querySelectorAll('.adh-doc-chip').forEach((btn) => {
    const active = btn.getAttribute('data-doc') === activeDocFilter;
    btn.classList.toggle('bg-[#2563EB]', active);
    btn.classList.toggle('text-white', active);
    btn.classList.toggle('bg-white', !active);
    btn.classList.toggle('dark:bg-[#0D1728]', !active);
    btn.classList.toggle('text-[#111827]', !active);
    btn.classList.toggle('dark:text-white', !active);
  });
}

function openPrintableWindow(title, bodyHtml, autoPrint = false) {
  const win = window.open('', '_blank', 'noopener,noreferrer');
  if (!win) return;
  win.document.write(`<!doctype html><html><head><title>${title}</title><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;padding:32px;color:#111827}h1{font-size:20px;margin:0 0 8px}.row{display:flex;justify-content:space-between;margin:0 0 16px;font-size:14px}p{font-size:12px;color:#6B7280;line-height:1.5}</style></head><body>${bodyHtml}</body></html>`);
  win.document.close();
  if (autoPrint) setTimeout(() => win.print(), 250);
}

async function loadAccountDocuments({ supabaseClient, getCurrentUser }) {
  const user = await getCurrentUser();
  if (!user || !supabaseClient) return [];
  try {
    const { data } = await supabaseClient.from('account_documents').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
    return data || [];
  } catch (err) {
    console.error(err);
    return [];
  }
}

function renderDocs(root, ctx) {
  const redirectNote = root.querySelector('#adhRedirectNote');
  const redirectText = root.querySelector('#adhRedirectText');
  const generateBtn = root.querySelector('#adhGenerateBtn');
  const chips = root.querySelector('#adhDocTypeChips');
  const list = root.querySelector('#adhDocsList');

  if (activeTab === 'tax') {
    redirectNote.classList.remove('hidden');
    chips.classList.add('hidden');
    generateBtn.classList.add('hidden');
    list.innerHTML = '';
    redirectText.textContent = 'Tax documents are managed on their own dedicated page.';
    return;
  }

  redirectNote.classList.add('hidden');
  chips.classList.remove('hidden');
  generateBtn.classList.remove('hidden');

  let filtered = currentDocs.filter((doc) => doc.account_type === activeTab);
  if (activeDocFilter !== 'all') filtered = filtered.filter((doc) => normalizeDocType(doc.doc_type) === activeDocFilter);

  list.innerHTML = filtered.length ? filtered.map((doc) => `
    <div class="w-full bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[16px] p-[14px] shadow-lg">
      <div class="flex items-start justify-between gap-[12px]">
        <div class="min-w-0">
          <div class="text-[13px] font-bold text-[#111827] dark:text-white">${doc.doc_type}</div>
          <div class="text-[12px] text-[#6B7280] dark:text-[#8E9CBA] mt-[2px]">${doc.period} · Ending ${ctx.formatCurrency(doc.ending_balance || 0)}</div>
        </div>
        <button class="adh-print w-[36px] h-[36px] rounded-full bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 flex items-center justify-center text-[#2563EB] cursor-pointer" data-id="${doc.id}"><svg class="w-[16px] h-[16px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"></path></svg></button>
      </div>
      <div class="grid grid-cols-3 gap-[8px] mt-[12px]">
        <button class="adh-download h-[38px] rounded-[12px] bg-[#2563EB] text-white text-[11px] font-semibold cursor-pointer" data-id="${doc.id}">Download PDF</button>
        <button class="adh-email h-[38px] rounded-[12px] bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 text-[#111827] dark:text-white text-[11px] font-semibold cursor-pointer" data-id="${doc.id}">Email</button>
        <button class="adh-official h-[38px] rounded-[12px] bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 text-[#111827] dark:text-white text-[11px] font-semibold cursor-pointer" data-id="${doc.id}">Official</button>
      </div>
    </div>
  `).join('') : '<div class="bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[16px] px-[16px] shadow-lg py-4 text-center text-[13px] text-[#6B7280] dark:text-[#8E9CBA]">No documents yet.</div>';

  list.querySelectorAll('.adh-download, .adh-print').forEach((btn) => {
    on(btn, 'click', () => {
      const doc = currentDocs.find((item) => String(item.id) === btn.getAttribute('data-id'));
      if (!doc) return;
      openPrintableWindow(`${doc.doc_type} — ${doc.period}`, `
        <h1>${doc.doc_type}</h1>
        <div class="row"><span>Statement Period</span><strong>${doc.period}</strong></div>
        <div class="row"><span>Account Number</span><strong>${ctx.getAccountNumber(doc.account_type || 'checking', 'account')}</strong></div>
        <div class="row"><span>Ending Balance</span><strong>${ctx.formatCurrency(doc.ending_balance || 0)}</strong></div>
        <div class="row"><span>Generated</span><strong>${new Date(doc.created_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</strong></div>
        <p>This is a system-generated summary based on your account records at the time of generation. It is not a substitute for an official audited statement.</p>
      `, btn.classList.contains('adh-print'));
    });
  });

  list.querySelectorAll('.adh-email').forEach((btn) => {
    on(btn, 'click', () => {
      const doc = currentDocs.find((item) => String(item.id) === btn.getAttribute('data-id'));
      if (!doc) return;
      const subject = encodeURIComponent(`${doc.doc_type} — ${doc.period}`);
      const body = encodeURIComponent(`Verceil Bank Document\n\nPeriod: ${doc.period}\nEnding Balance: ${ctx.formatCurrency(doc.ending_balance || 0)}\nAccount: ${ctx.getAccountNumber(doc.account_type || 'checking', 'account')}`);
      window.location.href = `mailto:?subject=${subject}&body=${body}`;
    });
  });

  list.querySelectorAll('.adh-official').forEach((btn) => {
    on(btn, 'click', () => ctx.showModal('Official Copy Requested', `Your request for an official ${activeTab} document copy has been submitted. Reference: ${ctx.genRef()}.`));
  });
}

export async function init(root, ctx, initialTab) {
  const { close, loadPage, showModal, supabaseClient, getCurrentUser, parseBalanceText } = ctx;
  on(root.querySelector('[data-action="close"]'), 'click', close);

  // Statements and tax forms are two tabs of this one screen rather than two
  // screens, so callers say which tab they meant. Anything unrecognised falls
  // through to the default.
  if (initialTab && root.querySelector(`.adh-tab[data-tab="${initialTab}"]`)) activeTab = initialTab;

  setActiveClasses(root);

  root.querySelectorAll('.adh-tab').forEach((btn) => {
    on(btn, 'click', () => {
      activeTab = btn.getAttribute('data-tab');
      setActiveClasses(root);
      renderDocs(root, ctx);
    });
  });

  root.querySelectorAll('.adh-doc-chip').forEach((btn) => {
    on(btn, 'click', () => {
      activeDocFilter = btn.getAttribute('data-doc');
      setActiveClasses(root);
      renderDocs(root, ctx);
    });
  });

  on(root.querySelector('#adhRedirectBtn'), 'click', () => loadPage('tax-docs'));
  on(root.querySelector('#adhOfficialLetterBtn'), 'click', () => showModal('Official Bank Letter Requested', `Your request has been received. Reference: ${ctx.genRef()}.`));

  on(root.querySelector('#adhGenerateBtn'), 'click', async () => {
    try {
      const user = await getCurrentUser();
      if (!user || !supabaseClient) throw new Error('no user');
      const docType = activeDocFilter === 'all' ? 'Monthly Statement' : (docTypeLabels[activeDocFilter] || 'Monthly Statement');
      const balanceEl = document.getElementById(balanceSourceIds[activeTab] || 'checkingBalance');
      await supabaseClient.from('account_documents').insert({
        user_id: user.id,
        account_type: activeTab,
        doc_type: docType,
        period: new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }),
        ending_balance: balanceEl ? parseBalanceText(balanceEl.textContent) : 0,
      });
      currentDocs = await loadAccountDocuments(ctx);
      renderDocs(root, ctx);
    } catch (err) {
      console.error(err);
      showModal('Could Not Generate', 'Please try again.');
    }
  });

  currentDocs = await loadAccountDocuments(ctx);
  renderDocs(root, ctx);
}

export function cleanup() {
  listeners.forEach((off) => off());
  listeners = [];
  activeTab = 'checking';
  activeDocFilter = 'all';
  currentDocs = [];
}
