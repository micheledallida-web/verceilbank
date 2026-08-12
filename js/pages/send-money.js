import { showReceipt } from '../shared/receipt.js';

let listeners = [];
function on(el, evt, fn) { el.addEventListener(evt, fn); listeners.push(() => el.removeEventListener(evt, fn)); }

export function init(root, ctx) {
  const { supabaseClient, getCurrentUser, genRef, formatCurrency, parseBalanceText, close } = ctx;

  const formStep = root.querySelector('#sendMoneyFormStep');
  const reviewStep = root.querySelector('#sendMoneyReviewStep');
  const name = root.querySelector('#zelleRecipientName');
  const contact = root.querySelector('#zelleRecipientContact');
  const amountInput = root.querySelector('#zelleAmount');
  const memo = root.querySelector('#zelleMemo');
  const formError = root.querySelector('#zelleFormError');
  const reviewError = root.querySelector('#zelleReviewError');

  let pendingZelle = null;

  on(root.querySelector('[data-action="close"]'), 'click', close);
  on(root.querySelector('[data-action="back-to-form"]'), 'click', () => {
    reviewStep.classList.add('hidden');
    formStep.classList.remove('hidden');
  });

  on(root.querySelector('#zelleContinueBtn'), 'click', () => {
    formError.classList.add('hidden');
    const amount = parseFloat(amountInput.value);
    if (!name.value.trim() || !contact.value.trim()) {
      formError.textContent = 'Please enter a recipient name and contact.';
      formError.classList.remove('hidden');
      return;
    }
    if (!amount || amount <= 0) {
      formError.textContent = 'Please enter a valid amount.';
      formError.classList.remove('hidden');
      return;
    }
    const checkingEl = document.getElementById('checkingBalance');
    const available = checkingEl ? parseBalanceText(checkingEl.textContent) : 0;
    if (amount > available) {
      formError.textContent = 'Insufficient funds in Verceil Checking.';
      formError.classList.remove('hidden');
      return;
    }

    pendingZelle = { name: name.value.trim(), contact: contact.value.trim(), amount, memo: memo.value.trim(), ref: genRef() };

    root.querySelector('#zelleReviewRecipient').textContent = pendingZelle.name;
    root.querySelector('#zelleReviewAmount').textContent = formatCurrency(amount);
    root.querySelector('#zelleReviewTotal').textContent = formatCurrency(amount);
    reviewError.classList.add('hidden');

    formStep.classList.add('hidden');
    reviewStep.classList.remove('hidden');
  });

  on(root.querySelector('#zelleSendBtn'), 'click', async (e) => {
    if (!pendingZelle) return;
    const btn = e.currentTarget;
    reviewError.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = 'Sending...';

    try {
      if (!supabaseClient) throw new Error('Supabase client not available');
      const user = await getCurrentUser();
      if (!user) throw new Error('Not signed in');

      const { error } = await supabaseClient.from('payments').insert({
        user_id: user.id,
        recipient_name: pendingZelle.name,
        recipient_contact: pendingZelle.contact,
        amount: pendingZelle.amount,
        memo: pendingZelle.memo,
        payment_method: 'zelle',
        status: 'completed',
        confirmation_number: pendingZelle.ref
      });
      if (error) throw error;

      ctx.recordTransaction({
        accountType: 'checking',
        amount: -Math.abs(pendingZelle.amount),
        title: `Zelle® to ${pendingZelle.name}`,
        iconText: '↑',
        category: 'zelle',
        reference: pendingZelle.ref,
      });

      const checkingEl = document.getElementById('checkingBalance');
      if (checkingEl) checkingEl.textContent = formatCurrency(parseBalanceText(checkingEl.textContent) - pendingZelle.amount);

      const receiptData = { amount: formatCurrency(pendingZelle.amount), recipient: pendingZelle.name, confirmation: pendingZelle.ref };
      btn.disabled = false;
      btn.textContent = 'Send Payment';
      pendingZelle = null;
      close();
      showReceipt(receiptData);
    } catch (err) {
      console.error('Send money error:', err);
      btn.disabled = false;
      btn.textContent = 'Send Payment';
      reviewError.textContent = 'This payment could not be sent. Please try again.';
      reviewError.classList.remove('hidden');
    }
  });
}

export function cleanup() {
  listeners.forEach(off => off());
  listeners = [];
}
