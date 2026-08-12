import { downloadDocument, documentFileName } from '../shared/documents.js';

const taxDocLabels = {
  '1099': '1099 Form',
  interest: 'Interest Statement',
  investment_tax: 'Investment Tax Form',
  archived: 'Archived Document',
};

let listeners = [];
let activeTaxDocTab = '1099';
let currentTaxDocs = [];
// The screen's context, kept here because renderTaxDocs is called from three
// places and its handlers need the Supabase client and the modal.
let pageCtx = null;

function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}

function setActiveTab(root) {
  root.querySelectorAll('.tax-doc-tab').forEach((btn) => {
    const active = btn.getAttribute('data-doc') === activeTaxDocTab;
    btn.classList.toggle('bg-[#2563EB]', active);
    btn.classList.toggle('text-white', active);
    btn.classList.toggle('bg-white', !active);
    btn.classList.toggle('dark:bg-[#0D1728]', !active);
    btn.classList.toggle('text-[#111827]', !active);
    btn.classList.toggle('dark:text-white', !active);
  });
}

async function loadTaxDocs({ supabaseClient, getCurrentUser }) {
  const user = await getCurrentUser();
  if (!user || !supabaseClient) return [];
  try {
    const { data } = await supabaseClient.from('tax_documents').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
    return data || [];
  } catch (err) {
    console.error(err);
    return [];
  }
}

function renderTaxDocs(root) {
  const list = root.querySelector('#taxDocsList');
  const filtered = currentTaxDocs.filter((doc) => doc.doc_type === activeTaxDocTab);
  if (filtered.length === 0) {
    list.innerHTML = '<div class="bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[18px] px-[16px] shadow-lg py-4"><div class="text-center text-[13px] text-[#6B7280] dark:text-[#8E9CBA] py-2">No documents in this category yet.</div></div>';
    return;
  }

  list.innerHTML = filtered.map((doc) => `
    <div class="w-full bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[16px] p-[14px] shadow-lg flex items-center justify-between">
      <div><div class="text-[13px] font-bold text-[#111827] dark:text-white">${taxDocLabels[doc.doc_type] || doc.doc_type}</div><div class="text-[12px] text-[#6B7280] dark:text-[#8E9CBA]">${doc.period}</div></div>
      <div class="flex gap-[6px]">
        <button class="td-download w-[36px] h-[36px] rounded-full bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 flex items-center justify-center text-[#2563EB] cursor-pointer" data-id="${doc.id}"><svg class="w-[16px] h-[16px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"></path></svg></button>
        <button class="td-email w-[36px] h-[36px] rounded-full bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 flex items-center justify-center text-[#2563EB] cursor-pointer" data-id="${doc.id}"><svg class="w-[16px] h-[16px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8l9 6 9-6M4 6h16a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V7a1 1 0 011-1z"></path></svg></button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.td-download').forEach((btn) => {
    on(btn, 'click', async () => {
      const doc = currentTaxDocs.find((item) => String(item.id) === btn.getAttribute('data-id'));
      if (!doc) return;
      const label = taxDocLabels[doc.doc_type] || doc.doc_type;
      try {
        await downloadDocument({
          supabaseClient: pageCtx && pageCtx.supabaseClient,
          row: doc,
          fileName: documentFileName(label, doc.period),
          pdf: {
            title: label,
            subtitle: `Tax year ${doc.period}`,
            rows: [
              ['Period', doc.period || '—'],
              ['Document Type', label],
              ['Generated', new Date(doc.created_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })],
            ],
            note: 'This is a system-generated summary and not a substitute for a certified tax filing record. '
              + 'File your return from the official form issued by the bank.',
          },
        });
      } catch (err) {
        console.error('Download tax document error:', err);
        if (pageCtx && pageCtx.showModal) {
          pageCtx.showModal('Could Not Download', 'This document could not be downloaded right now. Please try again.');
        }
      }
    });
  });

  list.querySelectorAll('.td-email').forEach((btn) => {
    on(btn, 'click', () => {
      const doc = currentTaxDocs.find((item) => String(item.id) === btn.getAttribute('data-id'));
      if (!doc) return;
      window.location.href = `mailto:?subject=${encodeURIComponent(`${taxDocLabels[doc.doc_type] || doc.doc_type} — ${doc.period}`)}&body=${encodeURIComponent('Please find your requested document summary attached from Verceil Bank.')}`;
    });
  });
}

export async function init(root, ctx) {
  const { loadPage, showModal, supabaseClient, getCurrentUser } = ctx;
  pageCtx = ctx;
  on(root.querySelector('[data-action="back"]'), 'click', () => loadPage('profile'));

  setActiveTab(root);
  root.querySelectorAll('.tax-doc-tab').forEach((btn) => {
    on(btn, 'click', () => {
      activeTaxDocTab = btn.getAttribute('data-doc');
      setActiveTab(root);
      renderTaxDocs(root);
    });
  });

  on(root.querySelector('#taxDocsGenerateBtn'), 'click', async () => {
    try {
      const user = await getCurrentUser();
      if (!user || !supabaseClient) throw new Error('no user');
      await supabaseClient.from('tax_documents').insert({ user_id: user.id, doc_type: activeTaxDocTab, period: new Date().getFullYear().toString() });
      currentTaxDocs = await loadTaxDocs(ctx);
      renderTaxDocs(root);
    } catch (err) {
      console.error(err);
      showModal('Could Not Generate', 'Please try again.');
    }
  });

  currentTaxDocs = await loadTaxDocs(ctx);
  renderTaxDocs(root);
}

export function cleanup() {
  listeners.forEach((off) => off());
  listeners = [];
  activeTaxDocTab = '1099';
  currentTaxDocs = [];
  pageCtx = null;
}
