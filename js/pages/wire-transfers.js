import { showReceipt } from '../shared/receipt.js';

let listeners = [];
let currentWireTab = 'domestic';
let pendingWire = null;

function on(el, evt, fn) { el.addEventListener(evt, fn); listeners.push(() => el.removeEventListener(evt, fn)); }

export function init(root, ctx) {
  const { supabaseClient, getCurrentUser, genRef, formatCurrency, parseBalanceText, close } = ctx;

  const formStep = root.querySelector('#wireFormStep');
  const reviewStep = root.querySelector('#wireReviewStep');
  const wireDomesticFields = root.querySelector('#wireDomesticFields');
  const wireIntlFields = root.querySelector('#wireIntlFields');
  const wireRecipientName = root.querySelector('#wireRecipientName');
  const wireBankName = root.querySelector('#wireBankName');
  const wireRouting = root.querySelector('#wireRouting');
  const wireSwift = root.querySelector('#wireSwift');
  const wireIban = root.querySelector('#wireIban');
  const wireCountry = root.querySelector('#wireCountry');
  const wireCurrency = root.querySelector('#wireCurrency');
  const wireAccountNumber = root.querySelector('#wireAccountNumber');
  const wireAmount = root.querySelector('#wireAmount');
  const wirePurpose = root.querySelector('#wirePurpose');
  const wireFormError = root.querySelector('#wireFormError');
  const wireReviewCard = root.querySelector('#wireReviewCard');
  const wireReviewError = root.querySelector('#wireReviewError');
  const wireSubmitBtn = root.querySelector('#wireSubmitBtn');
  const tabButtons = root.querySelectorAll('.wire-tab-btn');

  function updateWireTabUI() {
    tabButtons.forEach((btn) => {
      const active = btn.getAttribute('data-tab') === currentWireTab;
      btn.className = `wire-tab-btn flex-1 h-[38px] rounded-[12px] text-[13px] font-semibold cursor-pointer ${active ? 'bg-white text-[#111827]' : 'bg-white/15 text-white'}`;
    });

    if (currentWireTab === 'domestic') {
      wireDomesticFields.classList.remove('hidden');
      wireDomesticFields.classList.add('flex');
      wireIntlFields.classList.add('hidden');
      wireIntlFields.classList.remove('flex');
    } else {
      wireIntlFields.classList.remove('hidden');
      wireIntlFields.classList.add('flex');
      wireDomesticFields.classList.add('hidden');
      wireDomesticFields.classList.remove('flex');
    }
  }

  function showFormStep() {
    reviewStep.classList.add('hidden');
    formStep.classList.remove('hidden');
  }

  on(root.querySelector('[data-action="close"]'), 'click', close);
  on(root.querySelector('[data-action="back-to-form"]'), 'click', showFormStep);

  tabButtons.forEach((btn) => {
    on(btn, 'click', () => {
      currentWireTab = btn.getAttribute('data-tab');
      updateWireTabUI();
    });
  });

  on(root.querySelector('#wireReviewBtn'), 'click', () => {
    wireFormError.classList.add('hidden');
    const amount = parseFloat(wireAmount.value);

    if (!wireRecipientName.value.trim() || !wireBankName.value.trim() || !wireAccountNumber.value.trim()) {
      wireFormError.textContent = 'Please complete all required fields.';
      wireFormError.classList.remove('hidden');
      return;
    }
    if (!amount || amount <= 0) {
      wireFormError.textContent = 'Please enter a valid amount.';
      wireFormError.classList.remove('hidden');
      return;
    }

    const fundingEl = document.getElementById('savingsBalance');
    if (fundingEl && amount > parseBalanceText(fundingEl.textContent)) {
      wireFormError.textContent = 'Insufficient funds in High-Yield Savings.';
      wireFormError.classList.remove('hidden');
      return;
    }

    const fee = currentWireTab === 'international' ? 45 : 25;
    pendingWire = {
      type: currentWireTab,
      recipient: wireRecipientName.value.trim(),
      bank: wireBankName.value.trim(),
      account: wireAccountNumber.value.trim(),
      amount,
      purpose: wirePurpose.value.trim(),
      fee,
      currency: currentWireTab === 'international' ? (wireCurrency.value.trim() || 'USD') : 'USD',
      routing: wireRouting.value.trim(),
      swift: wireSwift.value.trim(),
      iban: wireIban.value.trim(),
      country: wireCountry.value.trim(),
      ref: genRef(),
    };

    const rows = [
      ['Recipient', pendingWire.recipient],
      ['Bank', pendingWire.bank],
      ['Amount', formatCurrency(pendingWire.amount)],
      ['Currency', pendingWire.currency],
      ['Fees', formatCurrency(pendingWire.fee)],
      ['Exchange Rate', currentWireTab === 'international' ? '1.00 (live rate applied at submission)' : 'N/A'],
      ['Estimated Delivery', currentWireTab === 'international' ? '1–3 business days' : 'Same business day'],
    ];

    wireReviewCard.innerHTML = rows.map(([label, value]) => `
      <div class="flex items-center justify-between py-[12px]">
        <span class="text-[13px] text-[#6B7280] dark:text-[#8E9CBA]">${label}</span>
        <span class="text-[14px] font-semibold text-[#111827] dark:text-white text-right">${value}</span>
      </div>
    `).join('');

    wireReviewError.classList.add('hidden');
    formStep.classList.add('hidden');
    reviewStep.classList.remove('hidden');
  });

  on(wireSubmitBtn, 'click', async () => {
    if (!pendingWire) return;

    wireReviewError.classList.add('hidden');
    wireSubmitBtn.disabled = true;
    wireSubmitBtn.textContent = 'Submitting...';

    try {
      if (!supabaseClient) throw new Error('Supabase client not available');
      const user = await getCurrentUser();
      if (!user) throw new Error('Not signed in');

      const { error } = await supabaseClient.from('wire_transfers').insert({
        user_id: user.id,
        wire_type: pendingWire.type,
        recipient_name: pendingWire.recipient,
        bank_name: pendingWire.bank,
        routing_or_swift: pendingWire.type === 'international' ? pendingWire.swift : pendingWire.routing,
        iban: pendingWire.iban || null,
        country: pendingWire.country || null,
        account_number: pendingWire.account,
        amount: pendingWire.amount,
        currency: pendingWire.currency,
        fee: pendingWire.fee,
        purpose: pendingWire.purpose,
        status: 'submitted',
      });
      if (error) throw error;

      // Submitted rather than completed: a wire is reviewed before it leaves,
      // and the ledger says so rather than showing money already gone.
      ctx.recordTransaction({
        accountType: 'savings',
        amount: -Math.abs(Number(pendingWire.amount) + Number(pendingWire.fee || 0)),
        title: `Wire to ${pendingWire.recipient}`,
        iconText: '↑',
        category: 'wire',
        reference: pendingWire.confirmation || null,
        status: 'pending',
      });

      const fundingEl = document.getElementById('savingsBalance');
      if (fundingEl) {
        fundingEl.textContent = formatCurrency(parseBalanceText(fundingEl.textContent) - pendingWire.amount - pendingWire.fee);
      }

      wireSubmitBtn.disabled = false;
      wireSubmitBtn.textContent = 'Submit Wire';
      const receipt = { amount: formatCurrency(pendingWire.amount), recipient: pendingWire.recipient, confirmation: pendingWire.ref };
      pendingWire = null;
      close();
      showReceipt(receipt);
    } catch (err) {
      console.error('Wire transfer error:', err);
      wireSubmitBtn.disabled = false;
      wireSubmitBtn.textContent = 'Submit Wire';
      wireReviewError.textContent = 'This wire could not be submitted. Please try again.';
      wireReviewError.classList.remove('hidden');
    }
  });

  updateWireTabUI();
}

export function cleanup() {
  listeners.forEach(off => off());
  listeners = [];
  currentWireTab = 'domestic';
  pendingWire = null;
}
