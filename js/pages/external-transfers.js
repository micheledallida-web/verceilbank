import { showReceipt } from '../shared/receipt.js';
import {
  readExternalAccountStanding,
  externalAccountHoldMessage,
} from '../shared/account-products.js';

const accountBalanceIds = { checking: 'checkingBalance', savings: 'savingsBalance', investments: 'investmentsBalance' };

let listeners = [];
let selectedExtAccount = null;
// The rows as the database returned them, by id.
let accountsById = new Map();

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

      // Every row used to be stamped "Verified" in green, whatever the bank
      // actually thought of it — including one added thirty seconds ago that
      // cannot be sent to. A badge that says the same thing on every card is
      // not a badge, it is decoration, and this one was decoration that read as
      // a safety assurance.
      accountsById = new Map(data.map((account) => [String(account.id), account]));

      extAccountsList.innerHTML = data.map((account) => {
        const standing = readExternalAccountStanding(account);
        const tone = standing.canTransfer
          ? 'text-[#16A34A] dark:text-[#22C55E]'
          : 'text-[#B45309] dark:text-[#FBBF24]';
        return `
        <button class="ext-account-row w-full bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[16px] p-[14px] shadow-lg flex items-center justify-between cursor-pointer text-left" data-id="${account.id}">
          <div class="min-w-0">
            <div class="text-[14px] font-semibold text-[#111827] dark:text-white truncate">${account.bank_name}</div>
            <div class="text-[12px] text-[#6B7280] dark:text-[#8E9CBA]">${account.account_type} • ****${String(account.account_number).slice(-4)}</div>
          </div>
          <span class="text-[11px] font-semibold ${tone} flex-shrink-0">${standing.label}</span>
        </button>`;
      }).join('');

      extAccountsList.querySelectorAll('.ext-account-row').forEach((row) => {
        on(row, 'click', () => {
          // The whole row is kept, not two attributes off the DOM. The submit
          // handler has to re-read the account's standing, and reading it back
          // out of markup the same page wrote is how a check ends up being
          // performed against the thing it was meant to check.
          selectedExtAccount = accountsById.get(row.getAttribute('data-id')) || null;
          if (!selectedExtAccount) return;
          extTransferHeader.textContent = `Transfer to ${selectedExtAccount.bank_name}`;
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

    // The hold, checked HERE and not when the account was linked.
    //
    // Linking is allowed to succeed quietly — the details are the customer's,
    // the row is theirs, and refusing at that moment would be the bank telling
    // somebody off for doing the thing it asked them to do. The refusal belongs
    // at the point it means something, which is the moment money is about to
    // move, and it is worded as what to do next rather than as a policy.
    //
    // This is a courtesy, not the control. A browser can be made to skip it.
    // What cannot be skipped is that `status` is not a column a customer
    // session may write — see section 13 of setup.sql — so an account that has
    // not been through customer care stays 'pending' whatever this screen does.
    const standing = readExternalAccountStanding(selectedExtAccount);
    if (!standing.canTransfer) {
      extTransferError.textContent = externalAccountHoldMessage(standing);
      extTransferError.classList.remove('hidden');
      return;
    }

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
      showReceipt({ amount: formatCurrency(amount), recipient: selectedExtAccount.bank_name, confirmation: ref });
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
  accountsById = new Map();
}
