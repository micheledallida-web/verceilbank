import { readExternalAccountStanding } from '../shared/account-products.js';

let listeners = [];
let addType = null;

function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}

function emptyState(message) {
  return `<div class="bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[14px] px-[16px] py-3 shadow-lg text-center text-[12px] text-[#6B7280] dark:text-[#8E9CBA]">${message}</div>`;
}

function showInlineForm(root, type) {
  addType = type;
  root.querySelector('#laAddFormTitle').textContent = type === 'brokerage' ? 'Add brokerage account' : 'Add payment provider';
  root.querySelector('#laAddForm').classList.remove('hidden');
}

async function loadLinkedAccountsSection(root, ctx) {
  const { supabaseClient, getCurrentUser } = ctx;
  const user = await getCurrentUser();
  if (!user || !supabaseClient) {
    root.querySelector('#laExternalBanksList').innerHTML = emptyState('None linked yet.');
    root.querySelector('#laBrokerageList').innerHTML = emptyState('None linked yet.');
    root.querySelector('#laProvidersList').innerHTML = emptyState('None linked yet.');
    return;
  }

  try {
    const { data: banks } = await supabaseClient.from('external_accounts').select('*').eq('user_id', user.id);
    root.querySelector('#laExternalBanksList').innerHTML = (banks && banks.length)
      ? banks.map((bank) => {
          // Same badge as the External Transfers screen, from the same function,
          // because two screens showing the same account different standings is
          // how somebody ends up on the phone asking which one to believe.
          const standing = readExternalAccountStanding(bank);
          const tone = standing.canTransfer ? 'text-[#16A34A]' : 'text-[#B45309] dark:text-[#FBBF24]';
          return `<div class="bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[14px] p-[12px] shadow-lg flex items-center justify-between"><span class="text-[13px] font-semibold text-[#111827] dark:text-white">${bank.bank_name} ••${String(bank.account_number || '').slice(-4)}</span><span class="text-[11px] ${tone} flex-shrink-0">${standing.label}</span></div>`;
        }).join('')
      : emptyState('None linked yet.');

    const { data: linked } = await supabaseClient.from('linked_accounts').select('*').eq('user_id', user.id);
    const brokerage = (linked || []).filter((item) => item.account_type === 'brokerage');
    const providers = (linked || []).filter((item) => item.account_type === 'payment_provider');
    const renderRow = (item) => `<div class="bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[14px] p-[12px] shadow-lg flex items-center justify-between"><span class="text-[13px] font-semibold text-[#111827] dark:text-white">${item.provider_name} — ${item.identifier}</span><button class="la-remove text-[11px] font-semibold text-[#EF4444] cursor-pointer" data-id="${item.id}">Remove</button></div>`;

    root.querySelector('#laBrokerageList').innerHTML = brokerage.length ? brokerage.map(renderRow).join('') : emptyState('None linked yet.');
    root.querySelector('#laProvidersList').innerHTML = providers.length ? providers.map(renderRow).join('') : emptyState('None linked yet.');

    root.querySelectorAll('.la-remove').forEach((btn) => {
      on(btn, 'click', async () => {
        await supabaseClient.from('linked_accounts').delete().eq('id', btn.getAttribute('data-id'));
        loadLinkedAccountsSection(root, ctx);
      });
    });
  } catch (err) {
    console.error('Load linked accounts error:', err);
  }
}

export async function init(root, ctx) {
  const { loadPage, showModal, supabaseClient, getCurrentUser } = ctx;

  on(root.querySelector('[data-action="back"]'), 'click', () => loadPage('profile'));
  root.querySelector('#laAddForm').classList.add('hidden');

  on(root.querySelector('#laAddBankBtn'), 'click', () => loadPage('link-account'));
  on(root.querySelector('#laAddBrokerageBtn'), 'click', () => showInlineForm(root, 'brokerage'));
  on(root.querySelector('#laAddProviderBtn'), 'click', () => showInlineForm(root, 'payment_provider'));

  on(root.querySelector('#laSaveBtn'), 'click', async () => {
    const name = root.querySelector('#laProviderName').value.trim();
    const identifier = root.querySelector('#laIdentifier').value.trim();
    if (!name || !identifier) {
      showModal('Missing Info', 'Please enter a provider name and identifier.');
      return;
    }

    try {
      const user = await getCurrentUser();
      if (!user || !supabaseClient || !addType) throw new Error('no user');
      await supabaseClient.from('linked_accounts').insert({ user_id: user.id, account_type: addType, provider_name: name, identifier });
      root.querySelector('#laProviderName').value = '';
      root.querySelector('#laIdentifier').value = '';
      root.querySelector('#laAddForm').classList.add('hidden');
      await loadLinkedAccountsSection(root, ctx);
    } catch (err) {
      console.error(err);
      showModal('Could Not Save', 'Please try again.');
    }
  });

  await loadLinkedAccountsSection(root, ctx);
}

export function cleanup() {
  listeners.forEach((off) => off());
  listeners = [];
  addType = null;
}
