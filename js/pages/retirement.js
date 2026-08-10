// Retirement Accounts — Invest > Retirement Accounts.
//
// Two products and one decision: a Traditional IRA, taxed when you take the
// money out, or a Roth IRA, taxed before it goes in. Everything else on the
// screen exists to serve that one choice — the limits you are working within,
// the rollover route for a plan you already have elsewhere, and an advisor if
// the choice is not obvious. That is the whole of it, deliberately.
//
// Opening one goes through the same identity gate as every other new account:
// nobody opens an account here without having been verified first.

// IRS figures for the tax year named below. They are revised annually — update
// all three together, or the screen will quote a limit against the wrong year.
const TAX_YEAR = 2026;
const CONTRIBUTION_LIMIT = 7500;
const CATCH_UP_LIMIT = 8600;

const PRODUCTS = [
  {
    key: 'ira_traditional',
    name: 'Traditional IRA',
    tagline: 'Deduct now, pay tax when you withdraw',
    accent: '#2563EB',
    features: [
      'Contributions may be tax-deductible',
      'Investments grow tax-deferred',
      'Withdrawals in retirement are taxed as income',
      'Required minimum distributions begin at 73',
    ],
  },
  {
    key: 'ira_roth',
    name: 'Roth IRA',
    tagline: 'Pay tax now, withdraw tax-free later',
    accent: '#8B5CF6',
    features: [
      'Contributions are made with after-tax money',
      'Qualified withdrawals are entirely tax-free',
      'No required minimum distributions',
      'Income limits apply to who may contribute',
    ],
  },
];

const PRODUCTS_BY_KEY = PRODUCTS.reduce((acc, p) => ({ ...acc, [p.key]: p }), {});

const PRIMARY_BTN_CLASS = 'w-full h-[50px] rounded-[14px] bg-[#2563EB] text-white text-[15px] font-semibold cursor-pointer shadow-lg';

let listeners = [];
function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}

function formatLimit(amount) {
  return `$${amount.toLocaleString('en-US')}`;
}

export function init(root, ctx) {
  const { close, loadPage, showModal, supabaseClient, getCurrentUser, genRef, formatCurrency, openSupportMessage } = ctx;

  const openSection = root.querySelector('#retOpenSection');
  const accountsSection = root.querySelector('#retAccountsSection');
  const accountsList = root.querySelector('#retAccountsList');
  const extras = root.querySelector('#retExtras');
  const confirmStep = root.querySelector('#retConfirmStep');
  const productsWrap = root.querySelector('#retProducts');
  const openBtn = root.querySelector('#retOpenBtn');
  const ctaHelper = root.querySelector('#retCtaHelper');

  // Traditional is preselected because it is the one most people open, and a
  // screen that asks you to choose before it will tell you anything is worse
  // than one with a sensible default already picked.
  let selectedKey = PRODUCTS[0].key;
  let ownedKeys = [];

  on(root.querySelector('[data-action="close"]'), 'click', close);

  root.querySelector('#retLimitTitle').textContent = `${TAX_YEAR} contribution limits`;
  root.querySelector('#retLimitStandard').textContent = formatLimit(CONTRIBUTION_LIMIT);
  root.querySelector('#retLimitCatchUp').textContent = formatLimit(CATCH_UP_LIMIT);

  // ---------- The two products ----------
  function renderProducts() {
    const choosable = PRODUCTS.filter((p) => !ownedKeys.includes(p.key));

    productsWrap.innerHTML = choosable.map((p) => {
      const isOn = p.key === selectedKey;
      return `
        <button class="ret-product w-full text-left rounded-[20px] p-[16px] shadow-lg cursor-pointer bg-white dark:bg-[#0D1728] border-2"
          style="border-color:${isOn ? p.accent : 'transparent'};" data-key="${p.key}">
          <div class="flex items-start justify-between gap-[12px] mb-[10px]">
            <div class="min-w-0">
              <div class="text-[15px] font-bold text-[#111827] dark:text-white">${p.name}</div>
              <div class="text-[12px] text-[#6B7280] dark:text-[#8E9CBA] mt-[2px]">${p.tagline}</div>
            </div>
            <span class="w-[22px] h-[22px] rounded-full flex items-center justify-center flex-shrink-0 border-2"
              style="border-color:${isOn ? p.accent : '#D1D5DB'}; background:${isOn ? p.accent : 'transparent'};">
              ${isOn ? '<svg class="w-[12px] h-[12px] text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3.4"><polyline points="20 6 9 17 4 12"></polyline></svg>' : ''}
            </span>
          </div>
          ${p.features.map((f) => `
            <div class="flex items-start gap-[8px] py-[3px]">
              <svg class="w-[13px] h-[13px] mt-[3px] flex-shrink-0" style="color:${p.accent};" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>
              <span class="text-[12px] text-[#111827] dark:text-white leading-snug">${f}</span>
            </div>
          `).join('')}
        </button>
      `;
    }).join('');

    productsWrap.querySelectorAll('.ret-product').forEach((btn) => {
      on(btn, 'click', () => {
        selectedKey = btn.getAttribute('data-key');
        renderProducts();
        applyCtaState();
      });
    });

    // Nothing left to open is not an empty state — it is the finished one.
    openSection.classList.toggle('hidden', choosable.length === 0);
  }

  // ---------- Accounts already held ----------
  function renderOwnedAccounts(rows) {
    accountsList.innerHTML = rows.map((row) => {
      const product = PRODUCTS_BY_KEY[row.account_type];
      if (!product) return '';
      return `
        <div class="bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[20px] p-[16px] shadow-lg">
          <div class="flex items-center justify-between gap-[12px]">
            <div class="min-w-0">
              <div class="text-[14px] font-semibold text-[#111827] dark:text-white">${product.name}</div>
              <div class="text-[12px] text-[#6B7280] dark:text-[#8E9CBA] mt-[2px]">${product.tagline}</div>
            </div>
            <div class="text-[18px] font-bold text-[#111827] dark:text-white flex-shrink-0">${formatCurrency(row.balance || 0)}</div>
          </div>
          <button class="ret-fund w-full h-[42px] rounded-[12px] bg-[#2563EB] text-white text-[13px] font-semibold cursor-pointer mt-[12px]">Add Funds</button>
        </div>
      `;
    }).join('');

    accountsList.querySelectorAll('.ret-fund').forEach((btn) => {
      on(btn, 'click', () => loadPage('fund-account'));
    });

    accountsSection.classList.toggle('hidden', rows.length === 0);
  }

  // ---------- Opening an account ----------
  async function openAccount() {
    const product = PRODUCTS_BY_KEY[selectedKey];
    openBtn.disabled = true;
    openBtn.textContent = 'Opening Account...';

    const confirmationNumber = genRef();
    const openingBalance = 0;

    try {
      if (supabaseClient) {
        const user = await getCurrentUser();
        if (user) {
          const { error } = await supabaseClient.from('accounts').upsert({
            user_id: user.id,
            account_type: product.key,
            balance: openingBalance,
            status: 'approved',
          }, { onConflict: 'user_id,account_type' });
          if (error) throw error;
        }
      }
    } catch (err) {
      console.error('Open IRA error:', err);
      openBtn.disabled = false;
      openBtn.textContent = `Open ${product.name}`;
      showModal('Could Not Open Account', 'Something went wrong opening your IRA. Please try again, or contact support if it keeps happening.');
      return;
    }

    ctx.recordEvent('account.opened', { account_type: product.key, product: product.name, reference: confirmationNumber });

    root.querySelector('#retConfirmTitle').textContent = `${product.name} opened`;
    root.querySelector('#retConfirmRef').textContent = confirmationNumber;
    root.querySelector('#retConfirmBalance').textContent = formatCurrency(openingBalance);

    openSection.classList.add('hidden');
    accountsSection.classList.add('hidden');
    extras.classList.add('hidden');
    confirmStep.classList.remove('hidden');
  }

  on(root.querySelector('#retFundBtn'), 'click', () => loadPage('fund-account'));
  on(root.querySelector('#retDoneBtn'), 'click', close);

  on(root.querySelector('#retRolloverBtn'), 'click', () => openSupportMessage({
    category: 'Investments',
    subject: 'Roll over a 401(k) into an IRA',
    body: 'I would like to roll a workplace retirement plan from a previous employer into a Verceil IRA. Please tell me what you need from me to start the transfer.',
  }));

  on(root.querySelector('#retAdvisorBtn'), 'click', () => loadPage('advisor'));

  // ---------- The gate ----------
  // Identical in shape to the Interest Checking gate: an account is opened only
  // for someone the bank has actually verified, and anyone else is sent to the
  // verification screen rather than being quietly refused at the last step.
  // The button is bound once, here, and what it does is swapped underneath it.
  // Re-binding on every state change would stack handlers, and a second tap
  // after switching products would then run the first product's handler too.
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
      .select('*')
      .eq('user_id', user.id)
      .in('account_type', PRODUCTS.map((p) => p.key));
    if (error) throw error;
    return data || [];
  }

  let kycProfile = null;

  function applyCtaState() {
    const product = PRODUCTS_BY_KEY[selectedKey];
    const status = kycProfile ? kycProfile.kyc_status : null;

    if (status === 'verified') {
      setCta(`Open ${product.name}`, '', openAccount);
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

  async function load() {
    openBtn.disabled = true;
    openBtn.textContent = 'Loading';
    openBtn.className = PRIMARY_BTN_CLASS + ' opacity-60';

    let rows = [];
    try {
      // Both reads at once: which IRAs are already held decides what is on
      // offer, and the verification status decides whether it can be opened.
      const [accounts, profile] = await Promise.all([readOwnedAccounts(), readKycStatus()]);
      rows = accounts;
      kycProfile = profile;
    } catch (err) {
      console.error('Retirement load error:', err);
    }

    ownedKeys = rows.map((row) => row.account_type);
    // Never leave a product selected that has just turned out to be held
    // already — it would no longer be on the list the button refers to.
    if (ownedKeys.includes(selectedKey)) {
      const next = PRODUCTS.find((p) => !ownedKeys.includes(p.key));
      selectedKey = next ? next.key : selectedKey;
    }

    renderOwnedAccounts(rows);
    renderProducts();
    applyCtaState();
  }

  load();
}

export function cleanup() {
  listeners.forEach((off) => off());
  listeners = [];
}
