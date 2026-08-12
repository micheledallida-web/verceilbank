// Open an Account — the one door to every product the bank offers.
//
// It asks the ownership question first, and that order is the whole design.
// Individual and joint are not two ways of filling in the same form; they are
// two different things a bank does. One is a decision a customer can make on
// their own, and it happens here, immediately. The other gives a second person
// unrestricted access to somebody's money, and it happens through a person —
// customer care or support — after the account has been held for sixty days.
//
// Reachable from the standalone row under the accounts on the dashboard, from
// the Accounts menu, and from the two offers, which arrive here with their
// product already chosen.

import {
  offerableProducts,
  ACCOUNT_PRODUCTS_BY_KEY,
  OWNERSHIP_INDIVIDUAL,
  OWNERSHIP_JOINT,
  JOINT_OWNER_MIN_DAYS,
  SUPPORT_PHONE,
  SUPPORT_PHONE_DISPLAY,
  SUPPORT_HOURS,
  readJointOwnerEligibility,
} from '../shared/account-products.js';

const OWNERSHIP_OPTIONS = [
  {
    key: OWNERSHIP_INDIVIDUAL,
    name: 'Individual',
    tagline: 'Owned by you alone',
    accent: '#2563EB',
    points: [
      'Open it now — nothing to arrange',
      'Only you can deposit, withdraw and close it',
      'You can add a joint owner later',
    ],
  },
  {
    key: OWNERSHIP_JOINT,
    name: 'Joint',
    tagline: 'Owned equally by you and one other person',
    accent: '#8B5CF6',
    points: [
      'Both owners have full access to the money',
      'Both must be identified and sign the agreement',
      `Opened with customer care after ${JOINT_OWNER_MIN_DAYS} days`,
    ],
  },
];

const JOINT_REQUIREMENTS = [
  ['The other owner\'s full legal name', 'Exactly as it appears on their government ID'],
  ['Their date of birth and Social Security number', 'We verify their identity the same way we verified yours'],
  ['Their address, phone number and email', 'They are contacted directly to confirm they agree'],
  ['Both signatures on the ownership agreement', 'We send it once both identities have been confirmed'],
];

const PRIMARY_BTN_CLASS = 'w-full h-[50px] rounded-[14px] bg-[#2563EB] text-white text-[15px] font-semibold cursor-pointer shadow-lg';

let listeners = [];
function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}

// Sized with an inline style rather than a Tailwind arbitrary value, because
// this one is built from a variable — `w-[${size}px]` is a class name that
// never appears in the source, so the compiler never generates it and the icon
// comes out the wrong size in the built stylesheet.
function checkIcon(color, size = 13) {
  return `<svg class="mt-[3px] flex-shrink-0" style="color:${color};width:${size}px;height:${size}px;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
}

// One selectable card, used for both the ownership options and the products —
// they are the same object asking the same kind of question, so they are drawn
// by the same function rather than by two that drift apart.
function selectableCard({ key, name, tagline, accent, points, selected }) {
  return `
    <button class="oa-choice w-full text-left rounded-[20px] p-[16px] shadow-lg cursor-pointer bg-white dark:bg-[#0D1728] border-2"
      style="border-color:${selected ? accent : 'transparent'};" data-key="${key}" aria-pressed="${selected}">
      <div class="flex items-start justify-between gap-[12px] mb-[10px]">
        <div class="min-w-0">
          <div class="text-[15px] font-bold text-[#111827] dark:text-white">${name}</div>
          <div class="text-[12px] text-[#6B7280] dark:text-[#8E9CBA] mt-[2px]">${tagline}</div>
        </div>
        <span class="w-[22px] h-[22px] rounded-full flex items-center justify-center flex-shrink-0 border-2"
          style="border-color:${selected ? accent : '#D1D5DB'}; background:${selected ? accent : 'transparent'};">
          ${selected ? '<svg class="w-[12px] h-[12px] text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3.4"><polyline points="20 6 9 17 4 12"></polyline></svg>' : ''}
        </span>
      </div>
      ${points.map((point) => `
        <div class="flex items-start gap-[8px] py-[3px]">
          ${checkIcon(accent)}
          <span class="text-[12px] text-[#111827] dark:text-white leading-snug">${point}</span>
        </div>
      `).join('')}
    </button>
  `;
}

export function init(root, ctx, options = {}) {
  const {
    close, loadPage, showModal, supabaseClient, getCurrentUser, genRef, formatCurrency,
    openSupportMessage, openAccountRow,
    MINIMUM_OPENING_DEPOSIT_LABEL, FUNDING_DEADLINE_DAYS,
  } = ctx;

  const ownershipStep = root.querySelector('#oaOwnershipStep');
  const productStep = root.querySelector('#oaProductStep');
  const jointStep = root.querySelector('#oaJointStep');
  const confirmStep = root.querySelector('#oaConfirmStep');
  const title = root.querySelector('#oaTitle');
  const ownershipOptions = root.querySelector('#oaOwnershipOptions');
  const productsWrap = root.querySelector('#oaProducts');
  const nothingLeft = root.querySelector('#oaNothingLeft');
  const riskNote = root.querySelector('#oaRiskNote');
  const openBtn = root.querySelector('#oaOpenBtn');
  const ctaHelper = root.querySelector('#oaCtaHelper');

  // Individual is preselected. It is what most people opening an account want,
  // and it is the only one of the two that can be completed on this screen —
  // a default that leads somewhere is better than no default at all.
  let ownership = OWNERSHIP_INDIVIDUAL;
  // The product asked for on the way in, if the customer arrived from an offer.
  // More than one answer is allowed now: somebody opening a savings account
  // alongside an investment account should not have to make two trips through
  // this screen. Order is preserved so the confirmation reads in the order the
  // cards were pressed.
  let selectedKeys = (options && options.product) ? [options.product] : [];
  // Which question this opening is asking. Open an Account asks the 'app' one —
  // which everyday account. The Invest entry asks the 'invest' one, which is
  // the investment account and savings. One screen, two surfaces, rather than a
  // second screen that answers the same thing differently.
  const surface = (options && options.surface) || 'app';
  let ownedKeys = [];
  let kycProfile = null;
  let jointEligibility = null;

  on(root.querySelector('[data-action="close"]'), 'click', close);

  root.querySelector('#oaMinDeposit').textContent = MINIMUM_OPENING_DEPOSIT_LABEL;
  root.querySelector('#oaFundingDays').textContent = String(FUNDING_DEADLINE_DAYS);
  root.querySelector('#oaJointCallNumber').textContent = `${SUPPORT_PHONE_DISPLAY} · ${SUPPORT_HOURS}`;
  root.querySelector('#oaJointCallBtn').setAttribute('href', `tel:${SUPPORT_PHONE}`);

  root.querySelector('#oaJointRequirements').innerHTML = JOINT_REQUIREMENTS.map(([label, detail], idx) => `
    <div class="flex items-start gap-[10px] py-[10px]${idx > 0 ? ' border-t border-gray-100 dark:border-white/[0.06]' : ''}">
      ${checkIcon('#8B5CF6', 14)}
      <span class="min-w-0">
        <span class="block text-[13px] font-medium text-[#111827] dark:text-white leading-snug">${label}</span>
        <span class="block text-[12px] text-[#6B7280] dark:text-[#8E9CBA] mt-[2px] leading-relaxed">${detail}</span>
      </span>
    </div>
  `).join('');

  // ---------- Step 1: ownership ----------
  function renderOwnership() {
    ownershipOptions.innerHTML = OWNERSHIP_OPTIONS
      .map((option) => selectableCard({ ...option, selected: option.key === ownership }))
      .join('');

    ownershipOptions.querySelectorAll('.oa-choice').forEach((btn) => {
      on(btn, 'click', () => {
        ownership = btn.getAttribute('data-key');
        renderOwnership();
      });
    });
  }

  // ---------- Step 2A: the products ----------
  // What this screen may open, less whatever is already held — a product a
  // customer holds is not something to open, and offering it would end in the
  // database refusing a duplicate.
  //
  // offerableProducts() defaults to the 'app' surface, which is now the two
  // checking products and nothing else — savings and the investment account
  // are their own pair, reached from Invest rather than answered for here.
  // Which leaves this screen doing one thing: a member who joined with one
  // checking account coming back for the other.
  function choosableProducts() {
    return offerableProducts(surface)
      .filter((product) => !ownedKeys.includes(product.key));
  }

  function renderProducts() {
    const choosable = choosableProducts();

    if (!choosable.length) {
      // Nothing left to choose. Savings is no longer stated here either — it
      // and the investment account are reached from Invest now, so this screen
      // says only that there is nothing on it left to open.
      productsWrap.innerHTML = '';
      nothingLeft.classList.remove('hidden');
      riskNote.classList.add('hidden');
      openBtn.classList.add('hidden');
      ctaHelper.classList.add('hidden');
      return;
    }

    nothingLeft.classList.add('hidden');
    openBtn.classList.remove('hidden');

    // Anything chosen that is no longer on the list — a product asked for on
    // the way in that turns out to be held already — quietly drops out. Nothing
    // is selected by default: a default cannot be un-chosen, and this list can.
    selectedKeys = selectedKeys.filter((key) => choosable.some((p) => p.key === key));

    productsWrap.innerHTML = choosable.map((product) => selectableCard({
      key: product.key,
      name: product.name,
      tagline: product.tagline,
      accent: product.accent,
      points: product.features,
      selected: selectedKeys.includes(product.key),
    })).join('');

    productsWrap.querySelectorAll('.oa-choice').forEach((btn) => {
      on(btn, 'click', () => {
        const key = btn.getAttribute('data-key');
        // Each card is its own yes or no. Press to add it, press again to take
        // it back — so one account, both accounts, or none are all said with
        // the same control, and nothing is ever stuck selected.
        selectedKeys = selectedKeys.includes(key)
          ? selectedKeys.filter((k) => k !== key)
          : selectedKeys.concat(key);
        renderProducts();
        applyCtaState();
      });
    });

    // The risk warning belongs to the product, so it appears when that product
    // is among the ones chosen and not as permanent small print under every
    // account.
    const risky = selectedKeys
      .map((key) => ACCOUNT_PRODUCTS_BY_KEY[key])
      .find((product) => product && product.risk);
    riskNote.textContent = (risky && risky.risk) || '';
    riskNote.classList.toggle('hidden', !risky);
  }

  // ---------- Step 2B: joint ----------
  function renderJointEligibility() {
    const icon = root.querySelector('#oaJointEligibilityIcon');
    const headline = root.querySelector('#oaJointEligibilityTitle');
    const body = root.querySelector('#oaJointEligibilityBody');
    const state = jointEligibility;

    if (!state || !state.known) {
      headline.textContent = `Available after ${JOINT_OWNER_MIN_DAYS} days`;
      body.textContent = `A joint owner can be added once an account has been held for ${JOINT_OWNER_MIN_DAYS} days. Customer care will confirm where you stand.`;
      return;
    }

    if (state.eligible) {
      icon.className = 'w-[34px] h-[34px] rounded-full flex items-center justify-center flex-shrink-0 bg-emerald-100 dark:bg-[#10B981]/20 text-emerald-700 dark:text-[#10B981]';
      icon.innerHTML = '<svg class="w-[17px] h-[17px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.6"><polyline points="20 6 9 17 4 12"></polyline></svg>';
      headline.textContent = 'You can add a joint owner';
      body.textContent = `You have banked with us for ${state.daysHeld} days. Call customer care or send us a message and we will take it from there.`;
      return;
    }

    headline.textContent = `Available on ${state.eligibleOn}`;
    // The number of days left, not a policy quoted at somebody — the rule is in
    // the sentence, but what they actually want to know is how long.
    const days = state.daysRemaining;
    body.textContent = `A joint owner can be added once an account has been held for ${JOINT_OWNER_MIN_DAYS} days. You have held yours for ${state.daysHeld}, so there ${days === 1 ? 'is 1 day' : `are ${days} days`} to go.`;
  }

  // ---------- Moving between the steps ----------
  function showStep(step) {
    ownershipStep.classList.toggle('hidden', step !== 'ownership');
    productStep.classList.toggle('hidden', step !== 'product');
    jointStep.classList.toggle('hidden', step !== 'joint');
    confirmStep.classList.toggle('hidden', step !== 'confirm');

    const titles = {
      ownership: 'Open an Account',
      product: 'Individual Account',
      joint: 'Joint Account',
      confirm: 'Account Opened',
    };
    title.textContent = titles[step] || 'Open an Account';
    root.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  on(root.querySelector('#oaOwnershipNext'), 'click', () => {
    ctx.recordEvent('open_account.ownership_chosen', { ownership });
    if (ownership === OWNERSHIP_JOINT) {
      showStep('joint');
      return;
    }
    showStep('product');
    applyCtaState();
  });

  on(root.querySelector('#oaBackToOwnership'), 'click', () => showStep('ownership'));
  on(root.querySelector('#oaJointBackBtn'), 'click', () => showStep('ownership'));

  on(root.querySelector('#oaJointEmailBtn'), 'click', () => {
    ctx.recordEvent('open_account.joint_support_requested', {});
    openSupportMessage({
      category: 'account_ownership',
      subject: 'Open a joint account',
      body: 'I would like to open a joint account, or add a joint owner to an account I already hold. '
        + 'Please tell me what you need from both of us and send the ownership agreement.',
    });
  });

  // ---------- Opening it ----------
  async function openAccount() {
    const products = selectedKeys.map((key) => ACCOUNT_PRODUCTS_BY_KEY[key]).filter(Boolean);
    if (!products.length) return;

    openBtn.disabled = true;
    openBtn.textContent = products.length > 1 ? 'Opening Accounts...' : 'Opening Account...';

    const confirmationNumber = genRef();
    const openingBalance = 0;

    // One at a time rather than in parallel. These are inserts against the same
    // table for the same customer, and a failure part-way through should leave
    // the accounts that already opened alone — which it does, because each is
    // its own row and openAccountRow treats an existing one as success.
    const opened = [];
    try {
      for (const product of products) {
        await openAccountRow(product.key);
        opened.push(product);
      }
    } catch (err) {
      console.error('Open account error:', err);
      openBtn.disabled = false;
      openBtn.textContent = `Open ${chosenLabel()}`;
      showModal(
        'Could Not Open Account',
        opened.length
          // Said plainly, because the customer is now in a different state from
          // the one they were in when they pressed the button.
          ? `${opened.map((p) => p.name).join(' and ')} opened, but the rest did not. Please try the remaining ones again, or contact support if it keeps happening.`
          : 'Something went wrong opening your account. Please try again, or contact support if it keeps happening.',
      );
      return;
    }

    ctx.recordEvent('account.opened', {
      account_types: products.map((p) => p.key),
      ownership: OWNERSHIP_INDIVIDUAL,
      products: products.map((p) => p.name),
      reference: confirmationNumber,
    });

    const names = products.map((p) => p.name);
    root.querySelector('#oaConfirmTitle').textContent = names.length > 1
      ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} opened`
      : `${names[0]} opened`;
    root.querySelector('#oaConfirmTerms').textContent = products.length > 1
      ? `Your accounts open with limited access. Deposit at least ${MINIMUM_OPENING_DEPOSIT_LABEL} within ${FUNDING_DEADLINE_DAYS} days for full access — an account left unfunded past that is closed.`
      : `Your account opens with limited access. Deposit at least ${MINIMUM_OPENING_DEPOSIT_LABEL} within ${FUNDING_DEADLINE_DAYS} days for full access — an account left unfunded past that is closed.`;
    root.querySelector('#oaConfirmRef').textContent = confirmationNumber;
    root.querySelector('#oaConfirmBalance').textContent = formatCurrency(openingBalance);

    showStep('confirm');
  }

  on(root.querySelector('#oaFundBtn'), 'click', () => loadPage('fund-account'));
  on(root.querySelector('#oaDoneBtn'), 'click', close);

  // ---------- The identity gate ----------
  // The same gate every other opening flow uses: an account is opened only for
  // somebody the bank has verified, and anybody else is taken to the
  // verification screen rather than being refused at the last step.
  //
  // The handler is bound once and swapped underneath the button. Re-binding on
  // every state change would stack handlers, and a second tap after switching
  // products would then run the first product's handler as well.
  let ctaHandler = null;
  on(openBtn, 'click', () => { if (ctaHandler) ctaHandler(); });

  function setCta(text, helperText, handler, enabled = true) {
    openBtn.textContent = text;
    openBtn.className = PRIMARY_BTN_CLASS + (enabled ? '' : ' opacity-60');
    openBtn.disabled = !enabled;
    ctaHelper.textContent = helperText;
    ctaHelper.classList.toggle('hidden', !helperText);
    ctaHandler = handler;
  }

  // What the button calls what is about to be opened. One account by name, two
  // or more by count — "Open Verceil Checking and High-Yield Savings and an
  // Investment Account" is a button nobody can read at a glance.
  function chosenLabel() {
    if (selectedKeys.length === 1) {
      const only = ACCOUNT_PRODUCTS_BY_KEY[selectedKeys[0]];
      return only ? only.name : '';
    }
    return `${selectedKeys.length} accounts`;
  }

  function applyCtaState() {
    // Nothing chosen — a state somebody can reach deliberately, by pressing the
    // marked card again. The button says what is missing rather than sitting
    // there enabled with nothing to act on.
    if (!selectedKeys.length) {
      setCta('Select an account to open', '', () => {}, false);
      return;
    }
    const status = kycProfile ? kycProfile.kyc_status : null;

    if (status === 'verified' || status === 'manually_approved') {
      setCta(`Open ${chosenLabel()}`, '', openAccount);
      return;
    }
    if (status === 'pending') {
      setCta('Verification in Review', "We'll notify you within 1 business day.", () => {}, false);
      return;
    }
    if (status === 'rejected') {
      setCta('Resubmit Your Information', (kycProfile && kycProfile.rejection_reason) || '', () => loadPage('verify'));
      return;
    }
    setCta('Verify Identity to Open', 'Identity verification takes about 3 minutes.', () => loadPage('verify'));
  }

  // ---------- Loading what the screen needs ----------
  async function readKycStatus() {
    if (!supabaseClient) return null;
    const user = await getCurrentUser();
    if (!user) return null;
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('kyc_status, rejection_reason')
      .eq('id', user.id)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function readOwnedAccounts() {
    if (!supabaseClient) return [];
    const user = await getCurrentUser();
    if (!user) return [];
    const { data, error } = await supabaseClient
      .from('accounts')
      .select('account_type, status')
      .eq('user_id', user.id);
    if (error) throw error;
    return data || [];
  }

  async function load() {
    setCta('Loading', '', () => {}, false);

    let rows = [];
    try {
      // Three independent reads, so they go out together: what is already held
      // decides what is on offer, the verification status decides whether it
      // can be opened, and the join date decides what the joint branch says.
      const [accounts, profile, joint] = await Promise.all([
        readOwnedAccounts(),
        readKycStatus(),
        readJointOwnerEligibility({ supabaseClient, getCurrentUser }),
      ]);
      rows = accounts;
      kycProfile = profile;
      jointEligibility = joint;
    } catch (err) {
      console.error('Open account load error:', err);
    }

    ownedKeys = rows.map((row) => row.account_type);

    renderOwnership();
    renderProducts();
    renderJointEligibility();
    applyCtaState();

    // Arriving from an offer means the product is already decided, so the
    // ownership question is answered with the default and the screen opens on
    // the product it was asked for. The ownership step is still one tap back.
    if (options && options.product) showStep('product');
  }

  renderOwnership();
  showStep('ownership');
  load();
}

export function cleanup() {
  listeners.forEach((off) => off());
  listeners = [];
}
