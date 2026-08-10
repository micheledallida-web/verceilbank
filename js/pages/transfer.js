import { showReceipt } from '../shared/receipt.js';

const accountLabels = { checking: 'Verceil Checking', savings: 'High-Yield Savings', investments: 'Investment Portfolio' };
const accountBalanceIds = { checking: 'checkingBalance', savings: 'savingsBalance', investments: 'investmentsBalance' };

let listeners = [];
function on(el, evt, fn) { el.addEventListener(evt, fn); listeners.push(() => el.removeEventListener(evt, fn)); }

export function init(root, ctx) {
  const { supabaseClient, getCurrentUser, genRef, formatCurrency, parseBalanceText, close } = ctx;

  const formStep = root.querySelector('#transferFormStep');
  const reviewStep = root.querySelector('#transferReviewStep');
  const transferFrom = root.querySelector('#transferFrom');
  const transferTo = root.querySelector('#transferTo');
  const transferAmount = root.querySelector('#transferAmount');
  const transferDate = root.querySelector('#transferDate');
  const transferMemo = root.querySelector('#transferMemo');
  const transferFormError = root.querySelector('#transferFormError');
  const transferReviewError = root.querySelector('#transferReviewError');

  transferDate.value = new Date().toISOString().slice(0, 10);

  let pendingTransfer = null;

  on(root.querySelector('[data-action="close"]'), 'click', close);
  on(root.querySelector('[data-action="back-to-form"]'), 'click', () => {
    reviewStep.classList.add('hidden');
    formStep.classList.remove('hidden');
  });

  on(root.querySelector('#transferContinueBtn'), 'click', () => {
    transferFormError.classList.add('hidden');
    const from = transferFrom.value;
    const to = transferTo.value;
    const amount = parseFloat(transferAmount.value);

    if (from === to) {
      transferFormError.textContent = 'From and To accounts must be different.';
      transferFormError.classList.remove('hidden');
      return;
    }
    if (!amount || amount <= 0) {
      transferFormError.textContent = 'Please enter a valid amount.';
      transferFormError.classList.remove('hidden');
      return;
    }
    const fromBalanceEl = document.getElementById(accountBalanceIds[from]);
    const fromBalance = fromBalanceEl ? parseBalanceText(fromBalanceEl.textContent) : 0;
    if (amount > fromBalance) {
      transferFormError.textContent = `Insufficient funds in ${accountLabels[from]}.`;
      transferFormError.classList.remove('hidden');
      return;
    }

    pendingTransfer = {
      from, to, amount,
      memo: transferMemo.value.trim(),
      transferDate: transferDate.value,
      confirmation: genRef()
    };

    root.querySelector('#reviewFrom').textContent = accountLabels[from];
    root.querySelector('#reviewTo').textContent = accountLabels[to];
    root.querySelector('#reviewAmount').textContent = formatCurrency(amount);
    root.querySelector('#reviewConfirmation').textContent = pendingTransfer.confirmation;
    transferReviewError.classList.add('hidden');

    formStep.classList.add('hidden');
    reviewStep.classList.remove('hidden');
  });

  on(root.querySelector('#transferConfirmBtn'), 'click', async (e) => {
    if (!pendingTransfer) return;
    const btn = e.currentTarget;
    transferReviewError.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = 'Processing...';

    try {
      if (!supabaseClient) throw new Error('Supabase client not available');
      const user = await getCurrentUser();
      if (!user) throw new Error('Not signed in');

      const { error } = await supabaseClient.from('transfers').insert({
        user_id: user.id,
        from_account: pendingTransfer.from,
        to_account: pendingTransfer.to,
        amount: pendingTransfer.amount,
        memo: pendingTransfer.memo,
        transfer_date: pendingTransfer.transferDate,
        status: 'completed'
      });
      if (error) throw error;

      // Two ledger rows, because a transfer is two movements: one account is
      // debited and another credited, and each account's activity list has to
      // show its own side of it.
      ctx.recordTransaction({
        accountType: pendingTransfer.from,
        amount: -Math.abs(pendingTransfer.amount),
        title: `Transfer to ${accountLabels[pendingTransfer.to]}`,
        iconText: '↑',
        category: 'transfer',
        reference: pendingTransfer.confirmation,
      });
      ctx.recordTransaction({
        accountType: pendingTransfer.to,
        amount: Math.abs(pendingTransfer.amount),
        title: `Transfer from ${accountLabels[pendingTransfer.from]}`,
        iconText: '↓',
        category: 'transfer',
        reference: pendingTransfer.confirmation,
      });

      const fromEl = document.getElementById(accountBalanceIds[pendingTransfer.from]);
      const toEl = document.getElementById(accountBalanceIds[pendingTransfer.to]);
      if (fromEl) fromEl.textContent = formatCurrency(parseBalanceText(fromEl.textContent) - pendingTransfer.amount);
      if (toEl) toEl.textContent = formatCurrency(parseBalanceText(toEl.textContent) + pendingTransfer.amount);

      btn.disabled = false;
      btn.textContent = 'Confirm Transfer';

      const receiptData = {
        amount: formatCurrency(pendingTransfer.amount),
        recipient: `${accountLabels[pendingTransfer.from]} → ${accountLabels[pendingTransfer.to]}`,
        confirmation: pendingTransfer.confirmation
      };
      pendingTransfer = null;
      close();
      showReceipt(receiptData);
    } catch (err) {
      console.error('Transfer error:', err);
      btn.disabled = false;
      btn.textContent = 'Confirm Transfer';
      transferReviewError.textContent = 'This transfer could not be completed. Please try again.';
      transferReviewError.classList.remove('hidden');
    }
  });
}

export function cleanup() {
  listeners.forEach(off => off());
  listeners = [];
}
