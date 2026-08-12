import { EXTERNAL_ACCOUNT_MIN_DAYS, SUPPORT_PHONE_DISPLAY } from '../shared/account-products.js';

let listeners = [];
function on(el, evt, fn) { el.addEventListener(evt, fn); listeners.push(() => el.removeEventListener(evt, fn)); }

export function init(root, ctx) {
  const { supabaseClient, getCurrentUser, showModal, close } = ctx;

  const linkBankName = root.querySelector('#linkBankName');
  const linkRoutingNumber = root.querySelector('#linkRoutingNumber');
  const linkAccountNumber = root.querySelector('#linkAccountNumber');
  const linkAccountType = root.querySelector('#linkAccountType');
  const linkAccountError = root.querySelector('#linkAccountError');
  const plaidLinkBtn = root.querySelector('#plaidLinkBtn');
  const linkAccountSaveBtn = root.querySelector('#linkAccountSaveBtn');
  const linkAccountSaveBtnLabel = root.querySelector('#linkAccountSaveBtnLabel');

  on(root.querySelector('[data-action="close"]'), 'click', close);

  on(linkAccountSaveBtn, 'click', async () => {
    const bankName = linkBankName.value.trim();
    const routing = linkRoutingNumber.value.trim();
    const account = linkAccountNumber.value.trim();
    const accountType = linkAccountType.value;

    linkAccountError.classList.add('hidden');

    if (!bankName) {
      linkAccountError.textContent = 'Please enter the bank name.';
      linkAccountError.classList.remove('hidden');
      return;
    }
    if (!/^\d{9}$/.test(routing)) {
      linkAccountError.textContent = 'Routing number must be exactly 9 digits.';
      linkAccountError.classList.remove('hidden');
      return;
    }
    if (!/^\d{4,17}$/.test(account)) {
      linkAccountError.textContent = 'Please enter a valid account number.';
      linkAccountError.classList.remove('hidden');
      return;
    }

    linkAccountSaveBtn.disabled = true;
    linkAccountSaveBtnLabel.textContent = 'Saving...';

    try {
      if (!supabaseClient) throw new Error('Supabase client not available');
      const user = await getCurrentUser();
      if (!user) throw new Error('Not signed in');

      const { error } = await supabaseClient
        .from('external_accounts')
        .insert({
          user_id: user.id,
          bank_name: bankName,
          routing_number: routing,
          account_number: account,
          account_type: accountType,
          link_method: 'manual',
        });

      if (error) throw error;

      linkAccountSaveBtn.disabled = false;
      linkAccountSaveBtnLabel.textContent = 'Save Account';
      linkBankName.value = '';
      linkRoutingNumber.value = '';
      linkAccountNumber.value = '';
      close();
      // Says what happened AND what has not happened yet. The old wording —
      // "linked successfully" and nothing else — left somebody to discover the
      // thirty-day hold at the moment they tried to send money, which is the
      // worst possible time to learn it.
      setTimeout(() => showModal(
        'Account Linked',
        `${bankName} account ending in ${account.slice(-4)} has been added. `
        + `Transfers to it become available ${EXTERNAL_ACCOUNT_MIN_DAYS} days from today, `
        + `and are activated by customer care on ${SUPPORT_PHONE_DISPLAY} once we have confirmed the request with you.`,
      ), 260);
    } catch (err) {
      console.error('Link external account error:', err);
      linkAccountSaveBtn.disabled = false;
      linkAccountSaveBtnLabel.textContent = 'Save Account';
      linkAccountError.textContent = 'Could not save this account right now. Please try again.';
      linkAccountError.classList.remove('hidden');
    }
  });

  on(plaidLinkBtn, 'click', () => {
    close();
    setTimeout(() => showModal('Instant Link', 'Instant bank linking via Plaid requires a backend-issued Link token. Connect your Plaid account on the server to enable this.'), 260);
  });
}

export function cleanup() {
  listeners.forEach(off => off());
  listeners = [];
}
