// Account Detail — opens from any account card on the dashboard shell
// (Checking, Savings, Investments, Credit). Expects the account `type` as
// the argument passed via loadPage('account-detail', type).

const accountConfigs = {
  checking: {
    title: 'Verceil Checking',
    balanceLabel: 'Available Balance',
    balanceSourceId: 'checkingBalance',
    iconBg: '#1D61F2',
    iconSvg: '<svg class="w-[26px] h-[26px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><rect x="3" y="6" width="18" height="12" rx="3"></rect><path d="M3 10h18"></path></svg>',
    number: '•4892',
  },
  interest_checking: {
    title: 'Vercel Interest Checking',
    balanceLabel: 'Available Balance · Up to 4.00% APY',
    balanceSourceId: 'interestCheckingBalance',
    iconBg: '#1D61F2',
    iconSvg: '<svg class="w-[26px] h-[26px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><rect x="3" y="6" width="18" height="12" rx="3"></rect><path d="M3 10h18"></path></svg>',
    number: '•2461',
  },
  savings: {
    title: 'High-Yield Savings',
    balanceLabel: 'Available Balance',
    balanceSourceId: 'savingsBalance',
    iconBg: '#10B981',
    iconSvg: '<svg class="w-[26px] h-[26px]" fill="currentColor" viewBox="0 0 24 24"><path d="M19.5 9.5c-0.7 0-1.3 0.3-1.8 0.7-1.2-1.3-2.9-2.2-4.7-2.2H11C8.2 8 6 10.2 6 13c0 0.8 0.2 1.5 0.5 2.2L5 17h3v1c0 0.6 0.4 1 1 1h2c0.6 0 1-0.4 1-1v-1h4v1c0 0.6 0.4 1 1 1h2c0.6 0 1-0.4 1-1v-1.2c1.8-1 3-2.9 3-5.1 0-1.8-1.5-3.3-3.5-3.3zM16 11c0.6 0 1 0.4 1 1s-0.4 1-1 1-1-0.4-1-1 0.4-1 1-1z"/></svg>',
    number: '•9104',
  },
  investments: {
    title: 'Investment Portfolio',
    balanceLabel: 'Total Value',
    balanceSourceId: 'investmentsBalance',
    iconBg: '#8B5CF6',
    iconSvg: '<svg class="w-[26px] h-[26px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"></path></svg>',
    number: '•7721',
  },
  credit: {
    title: 'Verceil Signature Card',
    balanceLabel: 'Account Status',
    balanceSourceId: null,
    iconBg: '#EF4444',
    iconSvg: '<svg class="w-[26px] h-[26px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><rect x="2" y="5" width="20" height="14" rx="3"></rect><path d="M2 10h20"></path><path d="M6 15h4"></path></svg>',
    number: 'Subject to credit approval',
    unapplied: true,
  },
};

// Icon set shared by every quick action card — blue outline strokes on a
// dark navy tile, per the Citi Mobile-style design spec.
const qaIcons = {
  transfer: '<svg class="w-[22px] h-[22px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M7 7h11m0 0l-4-4m4 4l-4 4M17 17H6m0 0l4 4m-4-4l4-4"></path></svg>',
  sendMoney: '<svg class="w-[22px] h-[22px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M22 2L11 13"></path><path stroke-linecap="round" stroke-linejoin="round" d="M22 2l-7 20-4-9-9-4 20-7z"></path></svg>',
  deposit: '<svg class="w-[22px] h-[22px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"></path></svg>',
  accountDetails: '<svg class="w-[22px] h-[22px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><rect x="4" y="4" width="16" height="16" rx="3"></rect><path stroke-linecap="round" d="M8 10h8M8 14h5"></path></svg>',
  goal: '<svg class="w-[22px] h-[22px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="8"></circle><circle cx="12" cy="12" r="4"></circle><circle cx="12" cy="12" r="0.5"></circle></svg>',
  interest: '<svg class="w-[22px] h-[22px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" d="M6 18L18 6"></path><circle cx="7.5" cy="7.5" r="2"></circle><circle cx="16.5" cy="16.5" r="2"></circle></svg>',
  directDeposit: '<svg class="w-[22px] h-[22px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 10l9-6 9 6"></path><path stroke-linecap="round" d="M5 10v9h14v-9M10 19v-6h4v6"></path></svg>',
  buy: '<svg class="w-[22px] h-[22px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 17l5-5 4 4 7-8"></path><path stroke-linecap="round" stroke-linejoin="round" d="M15 8h5v5"></path></svg>',
  sell: '<svg class="w-[22px] h-[22px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 7l5 5 4-4 7 8"></path><path stroke-linecap="round" stroke-linejoin="round" d="M15 16h5v-5"></path></svg>',
  portfolio: '<svg class="w-[22px] h-[22px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path d="M12 2v10l7 5"></path><circle cx="12" cy="12" r="9.5"></circle></svg>',
};

// Per-account-type Quick Actions — 2x2 grid, matches the copy in the
// problem statement 1:1. `action` is invoked with `ctx` when the card is tapped.
const quickActionConfigs = {
  checking: [
    { icon: qaIcons.transfer, title: 'Transfer', subtitle: 'Move money between Vercel accounts or external banks.', action: (ctx) => ctx.loadPage('transfer') },
    { icon: qaIcons.sendMoney, title: 'Send Money', subtitle: 'Send money using Zelle® or internal bank transfers.', action: (ctx) => ctx.loadPage('send-money') },
    { icon: qaIcons.deposit, title: 'Deposit Funds', subtitle: 'Add money to your checking account.', action: (ctx) => ctx.loadPage('fund-account') },
    { icon: qaIcons.accountDetails, title: 'Account Details', subtitle: 'View routing number, account number, and direct deposit information.', action: (ctx) => ctx.loadPage('account-details') },
  ],
  savings: [
    { icon: qaIcons.transfer, title: 'Transfer', subtitle: 'Move money to or from your savings account.', action: (ctx) => ctx.loadPage('transfer') },
    { icon: qaIcons.deposit, title: 'Deposit Funds', subtitle: 'Add funds to your savings account.', action: (ctx) => ctx.loadPage('fund-account') },
    { icon: qaIcons.goal, title: 'Savings Goal', subtitle: 'Create or manage savings goals.', action: (ctx) => ctx.loadPage('savings-goal') },
    { icon: qaIcons.interest, title: 'Interest Details', subtitle: 'View APY, interest earned, and payment history.', action: (ctx) => ctx.loadPage('interest-details', 'savings') },
  ],
  interest_checking: [
    { icon: qaIcons.transfer, title: 'Transfer', subtitle: 'Move money into or out of Interest Checking.', action: (ctx) => ctx.loadPage('transfer') },
    { icon: qaIcons.deposit, title: 'Deposit Funds', subtitle: 'Fund your Interest Checking account.', action: (ctx) => ctx.loadPage('fund-account') },
    { icon: qaIcons.directDeposit, title: 'Direct Deposit', subtitle: 'View and share direct deposit information.', action: (ctx) => ctx.loadPage('direct-deposit', 'interest_checking') },
    { icon: qaIcons.interest, title: 'Interest Details', subtitle: 'View APY, accrued interest, and monthly earnings.', action: (ctx) => ctx.loadPage('interest-details', 'interest_checking') },
  ],
  investments: [
    { icon: qaIcons.deposit, title: 'Add Funds', subtitle: 'Add money to your investment account.', action: (ctx) => ctx.loadPage('fund-account') },
    { icon: qaIcons.buy, title: 'Buy Investments', subtitle: 'Purchase stocks, ETFs, or mutual funds.', action: (ctx) => ctx.loadPage('trade', 'buy') },
    { icon: qaIcons.sell, title: 'Sell Investments', subtitle: 'Sell holdings and move proceeds to cash.', action: (ctx) => ctx.loadPage('trade', 'sell') },
    { icon: qaIcons.portfolio, title: 'Portfolio Details', subtitle: 'View holdings, performance, and investment activity.', action: (ctx) => ctx.loadPage('portfolio') },
  ],
};

let listeners = [];
function on(el, evt, fn) { el.addEventListener(evt, fn); listeners.push(() => el.removeEventListener(evt, fn)); }

export function init(root, ctx, type) {
  const { supabaseClient, getCurrentUser, getOrCreateTempNumber, loadPage, close } = ctx;

  const cfg = accountConfigs[type] || accountConfigs.checking;

  const detailAccountName = root.querySelector('#detailAccountName');
  const detailAccountIcon = root.querySelector('#detailAccountIcon');
  const detailAccountTitle = root.querySelector('#detailAccountTitle');
  const detailAccountNumber = root.querySelector('#detailAccountNumber');
  const detailAccountBalanceLabel = root.querySelector('#detailAccountBalanceLabel');
  const detailAccountBalance = root.querySelector('#detailAccountBalance');
  const detailAccountChevron = root.querySelector('#detailAccountChevron');
  const detailRoutingSection = root.querySelector('#detailRoutingSection');
  const detailRoutingRow = root.querySelector('#detailRoutingRow');
  const detailAccountRow = root.querySelector('#detailAccountRow');
  const detailFullRoutingNumber = root.querySelector('#detailFullRoutingNumber');
  const detailFullAccountNumber = root.querySelector('#detailFullAccountNumber');
  const detailQuickActionsSection = root.querySelector('#detailQuickActionsSection');
  const detailQuickActions = root.querySelector('#detailQuickActions');
  const detailTransactionsSection = root.querySelector('#detailTransactionsSection');
  const detailTransactionsList = root.querySelector('#detailTransactionsList');

  on(root.querySelector('[data-action="close"]'), 'click', close);

  function renderQuickActions() {
    const actions = quickActionConfigs[type] || quickActionConfigs.checking;
    detailQuickActions.innerHTML = actions.map((a, idx) => `
      <button class="detail-quick-action group text-left cursor-pointer flex flex-col gap-[10px] transition-transform duration-150 active:scale-[0.97]" data-index="${idx}">
        <div class="flex items-center justify-between">
          <span class="w-[38px] h-[38px] rounded-[12px] flex items-center justify-center flex-shrink-0 bg-white/15 text-white dark:bg-[rgba(37,99,235,0.12)] dark:text-[#2563EB]">${a.icon}</span>
          <svg class="w-[14px] h-[14px] text-[#52607D] opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </div>
        <div>
          <div class="text-[14px] font-semibold text-white leading-tight">${a.title}</div>
          <div class="text-[11px] font-normal text-white/70 dark:text-[#8E9CBA] mt-[3px] leading-snug line-clamp-2">${a.subtitle}</div>
        </div>
      </button>
    `).join('');

    detailQuickActions.querySelectorAll('.detail-quick-action').forEach((btn) => {
      on(btn, 'click', () => {
        const a = actions[parseInt(btn.getAttribute('data-index'), 10)];
        a.action(ctx);
      });
    });
  }

  detailAccountName.textContent = cfg.title;
  detailAccountTitle.textContent = cfg.title;
  detailAccountIcon.style.background = cfg.iconBg;
  detailAccountIcon.innerHTML = cfg.iconSvg;
  // The masked number was a literal in the config too. The server-assigned one
  // wins when there is one; the config text stays for accounts that have no
  // number to show, like a card that has not been applied for.
  const maskedAccountNumber = getOrCreateTempNumber(type, 'account');
  detailAccountNumber.textContent = maskedAccountNumber
    ? `•${String(maskedAccountNumber).slice(-4)}`
    : cfg.number;
  detailAccountBalanceLabel.textContent = cfg.balanceLabel;

  const balanceSourceEl = cfg.balanceSourceId ? document.getElementById(cfg.balanceSourceId) : null;
  detailAccountBalance.textContent = cfg.unapplied
    ? 'Apply'
    : (balanceSourceEl ? balanceSourceEl.textContent : '$0.00');

  function renderTransactions(transactions) {
    if (!transactions || transactions.length === 0) {
      detailTransactionsList.className = 'w-full bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[20px] px-[16px] shadow-lg py-4';
      detailTransactionsList.innerHTML = '<div class="text-center text-[14px] text-[#6B7280] dark:text-[#8E9CBA] py-2">No recent activity</div>';
      return;
    }

    detailTransactionsList.className = 'w-full bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[20px] px-[16px] shadow-lg divide-y divide-gray-100 dark:divide-white/[0.06]';
    detailTransactionsList.innerHTML = transactions.map(tx => {
      const isNegative = Number(tx.amount) < 0;
      const formattedAmount = `${isNegative ? '-' : '+'}$${Math.abs(Number(tx.amount)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const amountColorClass = isNegative ? 'text-[#111827] dark:text-[#FFFFFF]' : 'text-[#16A34A] dark:text-[#22C55E]';
      return `
        <div class="flex items-center justify-between py-[14px]">
          <div class="flex items-center gap-[12px]">
            <div class="w-[40px] h-[40px] rounded-[12px] bg-emerald-100 dark:bg-[#10B981]/20 text-emerald-700 dark:text-[#10B981] flex items-center justify-center font-bold text-xs">
              ${tx.icon_text || '↓'}
            </div>
            <div>
              <div class="text-[15px] font-semibold text-[#111827] dark:text-[#FFFFFF] leading-tight">${tx.title}</div>
              <div class="text-[12px] font-normal text-[#6B7280] dark:text-[#8E9CBA] mt-0.5">${tx.date_info}</div>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <div class="text-[15px] font-semibold ${amountColorClass}">${formattedAmount}</div>
            <svg class="w-[14px] h-[14px] text-gray-400 dark:text-[#52607D]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
          </div>
        </div>
      `;
    }).join('');
  }

  async function loadTransactions() {
    detailTransactionsList.className = 'w-full bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[20px] px-[16px] shadow-lg py-4';
    detailTransactionsList.innerHTML = '<div class="text-center text-[14px] text-[#6B7280] dark:text-[#8E9CBA] py-2">Loading...</div>';

    if (!supabaseClient) {
      renderTransactions([]);
      return;
    }

    try {
      const user = await getCurrentUser();
      if (!user) {
        renderTransactions([]);
        return;
      }

      const { data: txData, error: txError } = await supabaseClient
        .from('transactions')
        .select('*')
        .eq('user_id', user.id)
        .eq('account_type', type)
        .order('created_at', { ascending: false });

      if (txError) {
        renderTransactions([]);
        return;
      }

      renderTransactions(txData);
    } catch (err) {
      console.error('Account transactions fetch error:', err);
      renderTransactions([]);
    }
  }

  // An account you have not opened yet has no numbers, no actions and no
  // history — what it has instead is the terms you would be opening it under.
  async function renderCardEligibility() {
    const card = root.querySelector('#detailCardEligibility');
    const title = root.querySelector('#detailCardEligibilityTitle');
    const body = root.querySelector('#detailCardEligibilityBody');
    if (!card || !title || !body || !ctx.getCardEligibility) return;

    const { eligible, months, thresholdMonths, eligibleFrom } = await ctx.getCardEligibility();

    if (eligible) {
      title.textContent = 'Ready to apply';
      body.textContent = 'If you meet eligibility, message Support to begin your application. A representative will guide you through the next steps.';
    } else {
      title.textContent = `Available after ${thresholdMonths} months of membership`;
      const when = eligibleFrom || 'a later date';
      body.textContent = `You've been a member for ${months} months — eligible ${when}.`;
    }

    card.classList.remove('hidden');
  }

  if (cfg.unapplied) {
    detailAccountChevron.classList.remove('hidden');
    renderCardEligibility();
    detailRoutingSection.classList.add('hidden');
    detailQuickActionsSection.classList.add('hidden');
    detailTransactionsSection.classList.add('hidden');
  } else {
    const routingNumber = getOrCreateTempNumber(type, 'routing');
    detailFullRoutingNumber.textContent = routingNumber;
    detailFullAccountNumber.textContent = getOrCreateTempNumber(type, 'account');

    // Investments have no routing number to give, so the row goes rather than
    // sitting there empty — and the account number below it loses the divider
    // that was separating the two.
    detailRoutingRow.classList.toggle('hidden', !routingNumber);
    detailAccountRow.classList.toggle('border-t', !!routingNumber);
    detailRoutingSection.classList.remove('hidden');
    detailQuickActionsSection.classList.remove('hidden');
    detailTransactionsSection.classList.remove('hidden');
    renderQuickActions();
    loadTransactions();
  }
}

export function cleanup() {
  listeners.forEach(off => off());
  listeners = [];
}
