// Interest Checking — dashboard promo card "Get Started" flow. Two-step,
// in-dashboard experience: benefits overview -> Open Interest Checking ->
// premium confirmation. On approval the new account is added to the
// Accounts section and Account Summary via the shared `accounts` table
// (account_type: 'interest_checking'), same as every other account card.

import { depositInsuranceFeature } from '../shared/deposit-insurance.js';
import { APY_LABEL, APY_DISCLOSURE } from '../shared/rates.js';

const benefits = [
  APY_LABEL,
  'No monthly maintenance fees',
  ...depositInsuranceFeature(),
  'Mobile check deposit',
  'Zelle® transfers',
  'Early direct deposit',
];

let listeners = [];
function on(el, evt, fn) { if (!el) return; el.addEventListener(evt, fn); listeners.push(() => el.removeEventListener(evt, fn)); }

// Reveals the Interest Checking account card on the always-present dashboard
// shell and hides the promo banner now that the account has been opened.
function revealDashboardAccount(formatCurrency, balance) {
  const section = document.getElementById('sectionInterestChecking');
  const promo = document.getElementById('promoBanner');
  const balanceEl = document.getElementById('interestCheckingBalance');
  if (balanceEl) balanceEl.textContent = formatCurrency(balance);
  if (section) section.classList.remove('hidden');
  if (promo) promo.classList.add('hidden');
}

export function init(root, ctx) {
  const { close, loadPage, showModal, supabaseClient, getCurrentUser, genRef, formatCurrency } = ctx;

  const offerStep = root.querySelector('#icOfferStep');
  const confirmStep = root.querySelector('#icConfirmStep');
  const benefitsList = root.querySelector('#icBenefitsList');
  const openAccountBtn = root.querySelector('#icOpenAccountBtn');

  // Reg DD: the rate may not be advertised without the terms that qualify it.
  const apyDisclosure = root.querySelector('#icApyDisclosure');
  if (apyDisclosure) apyDisclosure.textContent = APY_DISCLOSURE;

  benefitsList.innerHTML = benefits.map((label, idx) => `
    <div class="flex items-center gap-[12px] px-[10px] py-[12px]${idx > 0 ? ' border-t border-gray-100 dark:border-white/[0.06]' : ''}">
      <span class="w-[22px] h-[22px] rounded-full bg-[#EFF6FF] dark:bg-[#1D61F2]/20 flex items-center justify-center flex-shrink-0">
        <svg class="w-[13px] h-[13px] text-[#2563EB] dark:text-[#3B82F6]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>
      </span>
      <span class="text-[14px] font-medium text-[#111827] dark:text-white">${label}</span>
    </div>
  `).join('');

  on(root.querySelector('[data-action="close"]'), 'click', close);

  const handleOpenAccount = async () => {
    openAccountBtn.disabled = true;
    openAccountBtn.textContent = 'Opening Account...';

    const confirmationNumber = genRef();
    const initialBalance = 0;

    try {
      if (supabaseClient) {
        const user = await getCurrentUser();
        if (user) {
          // Just the account that was asked for. Savings comes with becoming a
          // customer, not with every account opened afterwards — see the note
          // on `openWith` in js/shared/account-products.js.
          await ctx.openAccountRow('interest_checking');
          ctx.recordEvent('account.opened', { account_type: 'interest_checking', reference: confirmationNumber });
        }
      }
    } catch (err) {
      console.error('Open Interest Checking error:', err);
      openAccountBtn.disabled = false;
      openAccountBtn.textContent = 'Open Interest Checking';
      showModal('Could Not Open Account', 'Something went wrong opening your account. Please try again, or contact support if it keeps happening.');
      return;
    }

    root.querySelector('#icConfirmationNumber').textContent = confirmationNumber;
    root.querySelector('#icInitialBalance').textContent = formatCurrency(initialBalance);
    // The terms the account was just opened under, stated where they matter
    // most — on the screen that says the account now exists.
    root.querySelector('#icOpeningTerms').textContent =
      `Your accounts open with limited access. Deposit at least ${ctx.MINIMUM_OPENING_DEPOSIT_LABEL} within ${ctx.FUNDING_DEADLINE_DAYS} days for full access — an account left unfunded past that is closed.`;

    revealDashboardAccount(formatCurrency, initialBalance);

    openAccountBtn.disabled = false;
    openAccountBtn.textContent = 'Open Interest Checking';

    offerStep.classList.add('hidden');
    confirmStep.classList.remove('hidden');
  };

  on(root.querySelector('#icViewAccountBtn'), 'click', () => loadPage('account-detail', 'interest_checking'));
  on(root.querySelector('#icReturnToDashboardBtn'), 'click', close);

  // ---------- Primary CTA gate ----------
  // Persona is not installed yet, so identity verification is handled manually
  // by support and only a profile already marked verified opens the account
  // straight away. States B and C are wired up now so they begin working the
  // moment kyc_status / verified_at land on user_profile: flip
  // AUTOMATED_VERIFICATION_ENABLED and point startIdentityVerification() at
  // Persona. Nothing else in the gate has to change.
  const AUTOMATED_VERIFICATION_ENABLED = false;
  const VERIFICATION_MAX_AGE_DAYS = 365;

  // The only two statuses that let someone open the account. 'verified' is
  // what Persona will write once it is installed; 'manually_approved' is a rep
  // clearing someone by hand after checking their details off-platform. They
  // are kept separate so the two remain tellable apart in an audit rather than
  // a rep having to pass their approval off as an automated check.
  const APPROVED_KYC_STATUSES = ['verified', 'manually_approved'];

  // Reused verbatim from the two buttons already on this page, so the gate
  // introduces no new visual styles.
  const PRIMARY_BTN_CLASS = 'w-full h-[50px] rounded-[14px] bg-[#2563EB] text-white text-[15px] font-semibold cursor-pointer hover:opacity-90 transition-all shadow-lg';
  const SECONDARY_BTN_CLASS = 'w-full h-[50px] rounded-[14px] bg-white dark:bg-[#0D1728] border border-gray-200 dark:border-white/10 text-[#111827] dark:text-white text-[15px] font-semibold cursor-pointer hover:opacity-90 transition-all';

  const ctaHelper = document.createElement('div');
  ctaHelper.id = 'icCtaHelper';
  ctaHelper.className = 'hidden text-[12px] font-normal text-white/80 dark:text-[#8E9CBA] text-center';
  openAccountBtn.insertAdjacentElement('afterend', ctaHelper);

  function setCta(text, className, helperText, handler) {
    openAccountBtn.textContent = text;
    openAccountBtn.className = className;
    openAccountBtn.disabled = false;
    ctaHelper.textContent = helperText;
    ctaHelper.classList.toggle('hidden', !helperText);
    on(openAccountBtn, 'click', handler);
  }

  function startIdentityVerification() {
    if (AUTOMATED_VERIFICATION_ENABLED) {
      loadPage('contact-support');
      return;
    }
    showModal('Verify Your Identity', 'Automated identity checks are not switched on yet, so verification is handled by our support team. Contact support to confirm your details and we will open your Interest Checking account once you are verified.');
    loadPage('contact-support');
  }

  function isVerificationStale(verifiedAt) {
    if (!verifiedAt) return false;
    const ts = new Date(verifiedAt).getTime();
    if (!ts) return false;
    return (Date.now() - ts) / 86400000 > VERIFICATION_MAX_AGE_DAYS;
  }

  async function readGateState() {
    if (!supabaseClient) return null;
    const user = await getCurrentUser();
    if (!user) return null;
    // Two tables, so two requests, but issued together rather than waterfalled.
    // select('*') because kyc_status / verified_at are not on user_profile yet
    // and naming them explicitly would fail the whole request.
    const [profileRes, accountRes] = await Promise.all([
      supabaseClient.from('user_profile').select('*').eq('user_id', user.id).maybeSingle(),
      supabaseClient.from('accounts').select('id').eq('user_id', user.id).eq('account_type', 'interest_checking').limit(1),
    ]);
    const profile = profileRes.data || {};
    return {
      kycStatus: profile.kyc_status || null,
      verifiedAt: profile.verified_at || null,
      ownsProduct: !!(accountRes.data && accountRes.data.length),
    };
  }

  async function applyCtaState() {
    openAccountBtn.disabled = true;
    openAccountBtn.textContent = 'Loading';
    ctaHelper.classList.add('hidden');

    let gate = null;
    try {
      gate = await readGateState();
    } catch (err) {
      console.error('Interest Checking gate error:', err);
    }

    // A — already owns this product.
    if (gate && gate.ownsProduct) {
      setCta('View Your Interest Checking', SECONDARY_BTN_CLASS, '', () => loadPage('account-detail', 'interest_checking'));
      return;
    }
    // B — neither verified nor manually approved by a rep. Also catches
    // "state unknown", because someone we cannot confirm must never fall
    // through to opening an account.
    if (!gate || APPROVED_KYC_STATUSES.indexOf(gate.kycStatus) === -1) {
      setCta('Verify Identity to Open', PRIMARY_BTN_CLASS, AUTOMATED_VERIFICATION_ENABLED ? 'Identity verification takes about 3 minutes.' : 'Contact support to verify your identity — this is handled manually for now.', startIdentityVerification);
      return;
    }
    // C — verified, but too long ago.
    if (isVerificationStale(gate.verifiedAt)) {
      setCta('Confirm Your Details to Open', PRIMARY_BTN_CLASS, 'We need to reconfirm your information before opening a new account.', startIdentityVerification);
      return;
    }
    // D — verified, recent, does not own the product yet.
    setCta('Open Interest Checking', PRIMARY_BTN_CLASS, '', handleOpenAccount);
  }

  // ---------- Primary CTA gate, KYC edition ----------
  // Supersedes applyCtaState() above, which read user_profile and is left in
  // place untouched. This one reads profiles.kyc_status — the column the
  // representative-review flow actually writes — and routes anyone who is not
  // already verified into the verify view rather than to support.
  async function readKycProfile() {
    if (!supabaseClient) return null;
    const user = await getCurrentUser();
    if (!user) return null;
    // One request. rejection_reason rides along because the rejected state
    // renders it as the CTA's helper text.
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('kyc_status, rejection_reason')
      .eq('id', user.id)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function applyKycCtaState() {
    // Nothing actionable is ever on screen before the status is known.
    openAccountBtn.disabled = true;
    openAccountBtn.textContent = 'Loading';
    openAccountBtn.className = PRIMARY_BTN_CLASS + ' opacity-60';
    ctaHelper.classList.add('hidden');

    let profile = null;
    try {
      profile = await readKycProfile();
    } catch (err) {
      console.error('Interest Checking KYC gate error:', err);
    }

    const status = profile ? profile.kyc_status : null;

    if (status === 'verified') {
      setCta('Open Interest Checking', PRIMARY_BTN_CLASS, '', handleOpenAccount);
      return;
    }
    if (status === 'pending') {
      setCta('Verification in Review', PRIMARY_BTN_CLASS + ' opacity-60', "We'll notify you within 1 business day.", () => {});
      openAccountBtn.disabled = true;
      return;
    }
    if (status === 'rejected') {
      setCta('Resubmit Your Information', PRIMARY_BTN_CLASS, profile.rejection_reason || '', () => loadPage('verify'));
      return;
    }
    setCta('Verify Identity to Open', PRIMARY_BTN_CLASS, 'Identity verification takes about 3 minutes.', () => loadPage('verify'));
  }

  applyKycCtaState();
}

export function cleanup() {
  listeners.forEach(off => off());
  listeners = [];
}
