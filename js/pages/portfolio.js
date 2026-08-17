import { createPortfolioChart } from '../shared/portfolio-chart.js';

const categoryMeta = {
  stocks: { label: 'Stocks', color: '#2563EB' },
  etfs: { label: 'ETFs', color: '#8B5CF6' },
  mutual_funds: { label: 'Mutual Funds', color: '#F59E0B' },
  crypto: { label: 'Crypto', color: '#F97316' },
  cash: { label: 'Cash', color: '#10B981' },
};

let listeners = [];
let activeChart = null;
function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}

export function init(root, ctx) {
  const { supabaseClient, getCurrentUser, formatCurrency, parseBalanceText, showModal, close } = ctx;

  const overviewStep = root.querySelector('#portfolioOverviewStep');
  const addHoldingStep = root.querySelector('#addHoldingStep');
  const portTotalValue = root.querySelector('#portTotalValue');
  const portTodayChange = root.querySelector('#portTodayChange');
  const portTotalReturn = root.querySelector('#portTotalReturn');
  const portCategoryCards = root.querySelector('#portCategoryCards');
  const portTopHoldings = root.querySelector('#portTopHoldings');
  const portAllocationBars = root.querySelector('#portAllocationBars');
  const portDividendIncome = root.querySelector('#portDividendIncome');
  const portRecentActivity = root.querySelector('#portRecentActivity');
  const holdingSymbol = root.querySelector('#holdingSymbol');
  const holdingName = root.querySelector('#holdingName');
  const holdingCategory = root.querySelector('#holdingCategory');
  const holdingShares = root.querySelector('#holdingShares');
  const holdingPrice = root.querySelector('#holdingPrice');
  const addHoldingError = root.querySelector('#addHoldingError');
  const saveHoldingBtn = root.querySelector('#saveHoldingBtn');

  let currentHoldings = [];
  let chart = null;
  let portfolioTotalValue = 0;
  let baseTodayChangeText = '$0.00 (0.00%)';
  let baseTodayChangeColor = '#16A34A';
  let baseTotalValueText = '$0.00';

  function showOverviewStep() {
    addHoldingStep.classList.add('hidden');
    overviewStep.classList.remove('hidden');
  }

  function showAddHoldingStep() {
    addHoldingError.classList.add('hidden');
    holdingSymbol.value = '';
    holdingName.value = '';
    holdingCategory.value = 'stocks';
    holdingShares.value = '';
    holdingPrice.value = '';
    overviewStep.classList.add('hidden');
    addHoldingStep.classList.remove('hidden');
  }

  function updateRangeButtonState(activeBtn) {
    root.querySelectorAll('.port-range-btn').forEach(btn => {
      btn.classList.remove('bg-[#EFF6FF]', 'dark:bg-[#1D61F2]', 'text-[#2563EB]', 'dark:text-white', 'rounded-full', 'font-bold', 'px-3', 'py-1');
    });
    if (activeBtn) activeBtn.classList.add('bg-[#EFF6FF]', 'dark:bg-[#1D61F2]', 'text-[#2563EB]', 'dark:text-white', 'rounded-full', 'font-bold', 'px-3', 'py-1');
  }

  async function loadHoldings() {
    if (!supabaseClient) return [];
    try {
      const user = await getCurrentUser();
      if (!user) return [];
      const { data, error } = await supabaseClient
        .from('investment_portfolio')
        .select('*')
        .eq('user_id', user.id)
        .order('value', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (e) {
      console.error('Load portfolio error:', e);
      return [];
    }
  }

  async function loadRecentActivity() {
    if (!supabaseClient) return [];
    try {
      const user = await getCurrentUser();
      if (!user) return [];
      const { data, error } = await supabaseClient
        .from('investment_orders')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(5);
      if (error) throw error;
      return data || [];
    } catch (e) {
      console.error('Load investment activity error:', e);
      return [];
    }
  }

  function renderRecentActivity(orders) {
    if (!orders.length) {
      portRecentActivity.className = 'bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[20px] px-[16px] shadow-lg py-4 mb-[20px]';
      portRecentActivity.innerHTML = '<div class="text-center text-[14px] text-[#6B7280] dark:text-[#8E9CBA] py-2">No recent activity</div>';
      return;
    }

    portRecentActivity.className = 'bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[20px] px-[16px] shadow-lg divide-y divide-gray-100 dark:divide-white/[0.06] mb-[20px]';
    portRecentActivity.innerHTML = orders.map(order => {
      const isBuy = order.side === 'buy';
      const toneClass = isBuy ? 'text-[#2563EB]' : 'text-[#EF4444]';
      const amount = Number(order.total || 0);
      const dateLabel = order.created_at
        ? new Date(order.created_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
        : 'Pending';
      return `
        <div data-row class="flex items-center justify-between py-[14px]">
          <div>
            <div class="text-[14px] font-bold text-[#111827] dark:text-white">${isBuy ? 'Buy' : 'Sell'} ${order.symbol || ''}</div>
            <div class="text-[12px] text-[#6B7280] dark:text-[#8E9CBA]">${dateLabel}</div>
          </div>
          <div class="text-right">
            <div class="text-[14px] font-bold ${toneClass}">${formatCurrency(amount)}</div>
            <div class="text-[11px] text-[#6B7280] dark:text-[#8E9CBA]">${order.status || 'submitted'}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderPortfolioOverview() {
    const totalValue = currentHoldings.reduce((sum, h) => sum + Number(h.value || 0), 0);
    const totalDayChange = currentHoldings.reduce((sum, h) => sum + Number(h.day_change || 0), 0);
    const totalCostBasis = currentHoldings.reduce((sum, h) => sum + Number(h.cost_basis || 0), 0);
    const totalDividends = currentHoldings.reduce((sum, h) => sum + Number(h.dividend_income || 0), 0);
    const totalReturn = totalCostBasis > 0 ? totalValue - totalCostBasis : 0;
    const totalReturnPct = totalCostBasis > 0 ? (totalReturn / totalCostBasis) * 100 : 0;
    const todayPct = totalValue > 0 ? (totalDayChange / (totalValue - totalDayChange || 1)) * 100 : 0;

    portTotalValue.textContent = formatCurrency(totalValue);
    portTodayChange.style.color = totalDayChange >= 0 ? '#16A34A' : '#EF4444';
    portTodayChange.textContent = `${totalDayChange >= 0 ? '+' : ''}${formatCurrency(totalDayChange)} (${todayPct.toFixed(2)}%)`;
    portTotalReturn.style.color = totalReturn >= 0 ? '#16A34A' : '#EF4444';
    portTotalReturn.textContent = `${totalReturn >= 0 ? '+' : ''}${formatCurrency(totalReturn)} (${totalReturnPct.toFixed(2)}%)`;
    portDividendIncome.textContent = formatCurrency(totalDividends);

    const byCategory = {};
    Object.keys(categoryMeta).forEach(key => { byCategory[key] = 0; });
    currentHoldings.forEach(holding => {
      const key = Object.prototype.hasOwnProperty.call(byCategory, holding.category) ? holding.category : 'stocks';
      byCategory[key] += Number(holding.value || 0);
    });

    portCategoryCards.innerHTML = Object.keys(categoryMeta).map(key => {
      const meta = categoryMeta[key];
      return `
        <div data-row class="w-full bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[16px] p-[14px] shadow-lg flex items-center justify-between">
          <div class="flex items-center gap-[10px]">
            <span class="w-[10px] h-[10px] rounded-full flex-shrink-0" style="background:${meta.color};"></span>
            <span class="text-[14px] font-semibold text-[#111827] dark:text-white">${meta.label}</span>
          </div>
          <span class="text-[14px] font-bold text-[#111827] dark:text-white">${formatCurrency(byCategory[key])}</span>
        </div>
      `;
    }).join('');

    portAllocationBars.innerHTML = Object.keys(categoryMeta).map(key => {
      const meta = categoryMeta[key];
      const val = byCategory[key];
      const pct = totalValue > 0 ? (val / totalValue) * 100 : 0;
      return `
        <div data-row>
          <div class="flex items-center justify-between mb-[4px]">
            <span class="text-[12px] font-medium text-[#6B7280] dark:text-[#8E9CBA]">${meta.label}</span>
            <span class="text-[12px] font-semibold text-[#111827] dark:text-white">${pct.toFixed(1)}%</span>
          </div>
          <div class="w-full h-[6px] rounded-full bg-gray-100 dark:bg-white/10 overflow-hidden">
            <div class="h-full rounded-full" style="width:${pct}%; background:${meta.color};"></div>
          </div>
        </div>
      `;
    }).join('');

    if (!currentHoldings.length) {
      portTopHoldings.innerHTML = '<div class="bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[20px] px-[16px] shadow-lg py-4"><div class="text-center text-[14px] text-[#6B7280] dark:text-[#8E9CBA] py-2">No holdings yet — tap "Invest More" to add your first investment.</div></div>';
    } else {
      portTopHoldings.innerHTML = currentHoldings.slice(0, 5).map(holding => {
        const dayChange = Number(holding.day_change || 0);
        return `
          <div data-row class="w-full bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[16px] p-[14px] shadow-lg flex items-center justify-between">
            <div class="min-w-0">
              <div class="text-[14px] font-bold text-[#111827] dark:text-white">${holding.symbol}</div>
              <div class="text-[12px] text-[#6B7280] dark:text-[#8E9CBA] truncate">${holding.name || ''}</div>
            </div>
            <div class="text-right flex-shrink-0">
              <div class="text-[14px] font-bold text-[#111827] dark:text-white">${formatCurrency(holding.value)}</div>
              <div class="text-[12px] font-semibold" style="color:${dayChange >= 0 ? '#16A34A' : '#EF4444'};">${dayChange >= 0 ? '+' : ''}${formatCurrency(dayChange)}</div>
            </div>
          </div>
        `;
      }).join('');
    }

    const investmentsEl = document.getElementById('investmentsBalance');
    if (investmentsEl && totalValue >= 0) investmentsEl.textContent = formatCurrency(totalValue);

    portfolioTotalValue = totalValue;
    baseTodayChangeText = `${totalDayChange >= 0 ? '+' : ''}${formatCurrency(totalDayChange)} (${todayPct.toFixed(2)}%)`;
    baseTodayChangeColor = totalDayChange >= 0 ? '#16A34A' : '#EF4444';
    baseTotalValueText = formatCurrency(totalValue);

    if (chart) {
      chart.setEndValue(totalValue, 'portfolio');
    } else {
      chart = createPortfolioChart(root, {
        formatCurrency,
        onScrub: (value) => {
          if (value === null) {
            portTotalValue.textContent = baseTotalValueText;
            portTodayChange.style.color = baseTodayChangeColor;
            portTodayChange.textContent = baseTodayChangeText;
            return;
          }
          const diff = value - portfolioTotalValue;
          const pct = portfolioTotalValue > 0 ? (diff / portfolioTotalValue) * 100 : 0;
          portTotalValue.textContent = formatCurrency(value);
          portTodayChange.style.color = diff >= 0 ? '#16A34A' : '#EF4444';
          portTodayChange.textContent = `${diff >= 0 ? '+' : ''}${formatCurrency(diff)} (${pct.toFixed(2)}%)`;
        },
      });
      activeChart = chart;
      chart.setRange('1M', totalValue, false);
    }
  }

  async function refreshPortfolio() {
    portTopHoldings.innerHTML = '<div class="text-center text-[13px] text-white/70 py-4">Loading...</div>';
    currentHoldings = await loadHoldings();
    renderPortfolioOverview();
    renderRecentActivity(await loadRecentActivity());
  }

  on(root.querySelector('[data-action="close"]'), 'click', close);
  on(root.querySelector('[data-action="back-to-overview"]'), 'click', showOverviewStep);
  on(root.querySelector('#investMoreBtn'), 'click', showAddHoldingStep);
  on(root.querySelector('#rebalanceBtn'), 'click', () => {
    showModal('Rebalance Portfolio', 'Automated rebalancing will be available once Buy & Sell Investments is enabled on your account.');
  });

  root.querySelectorAll('.port-range-btn').forEach(btn => {
    on(btn, 'click', () => {
      updateRangeButtonState(btn);
      if (chart) chart.setRange(btn.getAttribute('data-range'), portfolioTotalValue);
    });
  });
  updateRangeButtonState(root.querySelector('.port-range-btn[data-range="1M"]'));

  on(saveHoldingBtn, 'click', async () => {
    const symbol = holdingSymbol.value.trim().toUpperCase();
    const name = holdingName.value.trim();
    const category = holdingCategory.value;
    const shares = parseFloat(holdingShares.value);
    const price = parseFloat(holdingPrice.value);

    addHoldingError.classList.add('hidden');
    if (!symbol) {
      addHoldingError.textContent = 'Please enter a symbol.';
      addHoldingError.classList.remove('hidden');
      return;
    }
    if (!shares || shares <= 0 || !price || price <= 0) {
      addHoldingError.textContent = 'Please enter valid shares and price.';
      addHoldingError.classList.remove('hidden');
      return;
    }
    if (!supabaseClient) {
      addHoldingError.textContent = 'Investment services are unavailable right now.';
      addHoldingError.classList.remove('hidden');
      return;
    }

    saveHoldingBtn.disabled = true;
    saveHoldingBtn.textContent = 'Saving...';

    try {
      const user = await getCurrentUser();
      if (!user) throw new Error('Not signed in');
      const value = shares * price;
      const { error } = await supabaseClient.from('investment_portfolio').insert({
        user_id: user.id,
        symbol,
        name: name || symbol,
        category,
        shares,
        price,
        value,
        cost_basis: value,
        day_change: 0,
        dividend_income: 0,
      });
      if (error) throw error;

      const investmentsEl = document.getElementById('investmentsBalance');
      if (investmentsEl) investmentsEl.textContent = formatCurrency(parseBalanceText(investmentsEl.textContent) + value);

      saveHoldingBtn.disabled = false;
      saveHoldingBtn.textContent = 'Add Holding';
      showOverviewStep();
      await refreshPortfolio();
    } catch (e) {
      console.error('Add holding error:', e);
      saveHoldingBtn.disabled = false;
      saveHoldingBtn.textContent = 'Add Holding';
      addHoldingError.textContent = 'Could not save this holding right now. Please try again.';
      addHoldingError.classList.remove('hidden');
    }
  });

  refreshPortfolio();
}

export function cleanup() {
  listeners.forEach(off => off());
  listeners = [];
  if (activeChart) {
    activeChart.destroy();
    activeChart = null;
  }
}
