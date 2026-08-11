import { showReceipt } from '../shared/receipt.js';

const accountBalanceIds = { savings: 'savingsBalance', investments: 'investmentsBalance' };

let listeners = [];
let selectedExtAccount = null;

function on(el, evt, fn) { el.addEventListener(evt, fn); listeners.push(() => el.removeEventListener(evt, fn)); }

export function init(root, ctx) {
  const { supabaseClient, getCurrentUser, genRef, formatCurrency, parseBalanceText, loadPage, close } = ctx;

  const extAccountsList = root.querySelector('#extAccountsList');
  const extAddBankBtn = root.querySelector('#extAddBankBtn');
  const extTransferForm = root.querySelector('#extTransferForm');
  const extTransferHeader = root.querySelector('#extTransferHeader');
  const extFromAccount = root.querySelector('#extFromAccount');
  const extTransferAmount = root.querySelector('#extTransferAmount');
  const extTransferDate = root.querySelector('#extTransferDate');
  const extTransferError = root.querySelector('#extTransferError');
  const extSubmitTransferBtn = root.querySelector('#extSubmitTransferBtn');

  async function loadExternalAccounts() {
    extAccountsList.innerHTML = '<div class="text-center text-[13px] text-white/70 py-2">Loading...</div>';

    try {
      const user = await getCurrentUser();
      if (!user || !supabaseClient) {
        extAccountsList.innerHTML = '';
        return;
      }

      const { data, error } = await supabaseClient
        .from('external_accounts')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (error) throw error;

      if (!data || data.length === 0) {
        extAccountsList.innerHTML = '<div class="bg-white dark:bg-[#0D1728] rounded-[16px] p-[16px] text-center text-[13px] text-[#6B7280] dark:text-[#8E9CBA]">No linked accounts yet — tap "Add External Bank" to link one.</div>';
        return;
      }

      extAccountsList.innerHTML = data.map((account) => `
        <button class="ext-account-row w-full bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[16px] p-[14px] shadow-lg flex items-center justify-between cursor-pointer text-left" data-id="${account.id}" data-name="${account.bank_name}">
          <div class="min-w-0">
            <div class="text-[14px] font-semibold text-[#111827] dark:text-white truncate">${account.bank_name}</div>
            <div class="text-[12px] text-[#6B7280] dark:text-[#8E9CBA]">${account.account_type} • ****${String(account.account_number).slice(-4)}</div>
          </div>
          <span class="text-[11px] font-semibold text-[#16A34A] dark:text-[#22C55E] flex-shrink-0">Verified</span>
        </button>
      `).join('');

      extAccountsList.querySelectorAll('.ext-account-row').forEach((row) => {
        on(row, 'click', () => {
          selectedExtAccount = { id: row.getAttribute('data-id'), name: row.getAttribute('data-name') };
          extTransferHeader.textContent = `Transfer to ${selectedExtAccount.name}`;
          extTransferAmount.value = '';
          extTransferDate.value = new Date().toISOString().slice(0, 10);
          extTransferError.classList.add('hidden');
          extTransferForm.classList.remove('hidden');
        });
      });
    } catch (err) {
      console.error('Load external accounts error:', err);
      extAccountsList.innerHTML = '<div class="text-center text-[13px] text-white/70 py-2">Could not load linked accounts.</div>';
    }
  }

  on(root.querySelector('[data-action="close"]'), 'click', close);
  on(extAddBankBtn, 'click', () => loadPage('link-account'));

  on(extSubmitTransferBtn, 'click', async () => {
    extTransferError.classList.add('hidden');
    const amount = parseFloat(extTransferAmount.value);

    if (!selectedExtAccount) return;
    if (!amount || amount <= 0) {
      extTransferError.textContent = 'Please enter a valid amount.';
      extTransferError.classList.remove('hidden');
      return;
    }

    const fromEl = document.getElementById(accountBalanceIds[extFromAccount.value]);
    if (fromEl && amount > parseBalanceText(fromEl.textContent)) {
      extTransferError.textContent = 'Insufficient funds in the selected account.';
      extTransferError.classList.remove('hidden');
      return;
    }

    extSubmitTransferBtn.disabled = true;
    extSubmitTransferBtn.textContent = 'Processing...';

    try {
      if (!supabaseClient) throw new Error('Supabase client not available');
      const user = await getCurrentUser();
      if (!user) throw new Error('Not signed in');
      const ref = genRef();

      const { error } = await supabaseClient.from('external_transfers').insert({
        user_id: user.id,
        external_account_id: selectedExtAccount.id,
        from_account: extFromAccount.value,
        amount,
        transfer_date: extTransferDate.value,
        status: 'completed',
      });

      if (error) throw error;

      ctx.recordTransaction({
        accountType: extFromAccount.value,
        amount: -Math.abs(amount),
        title: `External transfer to ${selectedExtAccount.bank_name || 'linked account'}`,
        iconText: '↑',
        category: 'external_transfer',
        reference: ref,
      });

      if (fromEl) {
        fromEl.textContent = formatCurrency(parseBalanceText(fromEl.textContent) - amount);
      }

      extSubmitTransferBtn.disabled = false;
      extSubmitTransferBtn.textContent = 'Submit Transfer';
      close();
      showReceipt({ amount: formatCurrency(amount), recipient: selectedExtAccount.name, confirmation: ref });
    } catch (err) {
      console.error('External transfer error:', err);
      extSubmitTransferBtn.disabled = false;
      extSubmitTransferBtn.textContent = 'Submit Transfer';
      extTransferError.textContent = 'This transfer could not be completed. Please try again.';
      extTransferError.classList.remove('hidden');
    }
  });

  loadExternalAccounts();
}

export function cleanup() {
  listeners.forEach(off => off());
  listeners = [];
  selectedExtAccount = null;
}
