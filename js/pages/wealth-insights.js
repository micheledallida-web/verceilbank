const categoryMeta = {
  stocks: { label: 'Stocks', color: '#2563EB' },
  etfs: { label: 'ETFs', color: '#8B5CF6' },
  mutual_funds: { label: 'Mutual Funds', color: '#F59E0B' },
  crypto: { label: 'Crypto', color: '#F97316' },
  cash: { label: 'Cash', color: '#10B981' },
};

let listeners = [];
function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}

export function init(root, ctx) {
  const { supabaseClient, getCurrentUser, formatCurrency, parseBalanceText, getAccountNumber, showModal, loadPage, close } = ctx;

  let latestReport = null;

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
      console.error('Load holdings error:', e);
      return [];
    }
  }

  async function loadGoals() {
    if (!supabaseClient) return [];
    try {
      const user = await getCurrentUser();
      if (!user) return [];
      const { data, error } = await supabaseClient
        .from('financial_goals')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (e) {
      console.error('Load goals error:', e);
      return [];
    }
  }

  function computeRiskProfile(holdings, totalValue) {
    if (totalValue <= 0) return { score: 0, label: 'No Holdings Yet', concentrationPct: 0 };
    const byCategory = {};
    holdings.forEach(holding => {
      byCategory[holding.category] = (byCategory[holding.category] || 0) + Number(holding.value || 0);
    });
    const riskWeights = { crypto: 100, stocks: 70, etfs: 55, mutual_funds: 45, cash: 5, bonds: 20 };
    let weightedRisk = 0;
    Object.keys(byCategory).forEach(cat => {
      const pct = byCategory[cat] / totalValue;
      weightedRisk += pct * (riskWeights[cat] !== undefined ? riskWeights[cat] : 50);
    });
    const maxHolding = Math.max(...holdings.map(holding => Number(holding.value || 0)));
    const concentrationPct = (maxHolding / totalValue) * 100;
    const score = Math.min(100, Math.round(weightedRisk + Math.max(0, concentrationPct - 30) * 0.3));
    let label = 'Conservative';
    if (score >= 80) label = 'Aggressive';
    else if (score >= 60) label = 'Growth';
    else if (score >= 40) label = 'Balanced';
    else if (score >= 20) label = 'Moderate';
    return { score, label, concentrationPct };
  }

  function generateRecommendations(holdings, totalValue, cashValue, risk) {
    const recs = [];
    if (!holdings.length) {
      recs.push({ title: 'Start Investing', priority: 'High', impact: 'High', action: 'Add your first holding to begin building your portfolio.', target: () => loadPage('portfolio') });
      return recs;
    }
    const cashPct = totalValue > 0 ? (cashValue / totalValue) * 100 : 0;
    if (cashPct > 25) {
      recs.push({ title: 'Improve Cash Allocation', priority: 'Medium', impact: 'Medium', action: `Cash makes up ${cashPct.toFixed(0)}% of your portfolio — consider putting excess cash to work.`, target: () => loadPage('trade', 'buy') });
    }
    if (risk.concentrationPct > 40) {
      recs.push({ title: 'Reduce Concentration Risk', priority: 'High', impact: 'High', action: `Your largest holding is ${risk.concentrationPct.toFixed(0)}% of your portfolio — consider diversifying.`, target: () => loadPage('portfolio') });
    }
    const categoriesUsed = new Set(holdings.map(holding => holding.category)).size;
    if (categoriesUsed < 3) {
      recs.push({ title: 'Increase Diversification', priority: 'Medium', impact: 'Medium', action: `You're invested in only ${categoriesUsed} asset ${categoriesUsed === 1 ? 'category' : 'categories'} — spreading across more can reduce risk.`, target: () => loadPage('watchlist') });
    }
    const underwater = holdings.filter(holding => Number(holding.value) < Number(holding.cost_basis || holding.value));
    if (underwater.length > 0) {
      recs.push({ title: 'Tax-Loss Harvesting Opportunity', priority: 'Low', impact: 'Medium', action: `${underwater.length} holding(s) are below cost basis and could offset capital gains if sold.`, target: () => loadPage('portfolio') });
    }
    if (!recs.length) {
      recs.push({ title: 'Portfolio Looks Balanced', priority: 'Low', impact: 'Low', action: 'No urgent recommendations right now — keep monitoring your allocation regularly.', target: null });
    }
    return recs;
  }

  function renderWealthGoals(goals) {
    const wiGoalsList = root.querySelector('#wiGoalsList');
    if (!goals.length) {
      wiGoalsList.innerHTML = '<div class="bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[20px] px-[16px] shadow-lg py-4"><div class="text-center text-[14px] text-[#6B7280] dark:text-[#8E9CBA] py-2">No goals set yet. Tap "+ Add Goal" to start tracking one.</div></div>';
      return;
    }
    wiGoalsList.innerHTML = goals.map(goal => {
      const pct = goal.target_amount > 0 ? Math.min(100, (Number(goal.current_amount || 0) / Number(goal.target_amount)) * 100) : 0;
      return `
        <div class="bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[16px] p-[14px] shadow-lg">
          <div class="flex items-center justify-between mb-[6px]">
            <span class="text-[14px] font-bold text-[#111827] dark:text-white">${goal.goal_type}</span>
            <span class="text-[12px] text-[#6B7280] dark:text-[#8E9CBA]">${formatCurrency(goal.current_amount || 0)} / ${formatCurrency(goal.target_amount)}</span>
          </div>
          <div class="w-full h-[6px] rounded-full bg-gray-100 dark:bg-white/10 overflow-hidden mb-[6px]"><div class="h-full rounded-full bg-[#2563EB]" style="width:${pct}%;"></div></div>
          <div class="text-[11px] text-[#6B7280] dark:text-[#8E9CBA]">${goal.target_date ? `Target date: ${goal.target_date}` : 'No target date set'}</div>
        </div>
      `;
    }).join('');
  }

  function applyRangeButtonState(activeRange) {
    root.querySelectorAll('.wi-range-btn').forEach(btn => {
      btn.classList.remove('bg-[#EFF6FF]', 'dark:bg-[#1D61F2]', 'text-[#2563EB]', 'dark:text-white', 'rounded-full', 'font-bold', 'px-3', 'py-1');
      if (btn.getAttribute('data-range') === activeRange) btn.classList.add('bg-[#EFF6FF]', 'dark:bg-[#1D61F2]', 'text-[#2563EB]', 'dark:text-white', 'rounded-full', 'font-bold', 'px-3', 'py-1');
    });
  }

  function openReportPrintView() {
    if (!latestReport) return;
    root.querySelector('#wiReportMeta').textContent = `Portfolio report · ${latestReport.periodLabel} · Account ending •${String(latestReport.accountNumber).slice(-4)}`;
    root.querySelector('#wiReportBody').innerHTML = `
      <div style="display:flex;justify-content:space-between;margin-bottom:16px;"><span>Total Net Worth</span><strong>${formatCurrency(latestReport.netWorth)}</strong></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:16px;"><span>Investment Value</span><strong>${formatCurrency(latestReport.investValue)}</strong></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:16px;"><span>Cash Holdings</span><strong>${formatCurrency(latestReport.cashHoldings)}</strong></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:16px;"><span>Total Return</span><strong>${latestReport.totalReturn >= 0 ? '+' : ''}${formatCurrency(latestReport.totalReturn)}</strong></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:16px;"><span>Dividend Income</span><strong>${formatCurrency(latestReport.totalDividends)}</strong></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:16px;"><span>Risk Profile</span><strong>${latestReport.riskLabel}</strong></div>
      <p style="color:#6B7280;font-size:12px;margin-top:24px;">This wealth report is a system-generated summary based on current balances and holdings. It is intended for planning purposes only.</p>
    `;
    root.querySelector('#wiReportPrintView').classList.remove('hidden');
  }

  async function refreshInsights() {
    const currentHoldings = await loadHoldings();
    const checking = parseBalanceText(document.getElementById('checkingBalance')?.textContent || '$0.00');
    const savings = parseBalanceText(document.getElementById('savingsBalance')?.textContent || '$0.00');
    const investValue = currentHoldings.reduce((sum, holding) => sum + Number(holding.value || 0), 0);
    const cashHoldings = checking + savings;
    const netWorth = cashHoldings + investValue;
    const totalDayChange = currentHoldings.reduce((sum, holding) => sum + Number(holding.day_change || 0), 0);
    const totalCostBasis = currentHoldings.reduce((sum, holding) => sum + Number(holding.cost_basis || 0), 0);
    const totalReturn = totalCostBasis > 0 ? investValue - totalCostBasis : 0;
    const totalDividends = currentHoldings.reduce((sum, holding) => sum + Number(holding.dividend_income || 0), 0);

    root.querySelector('#wiNetWorth').textContent = formatCurrency(netWorth);
    root.querySelector('#wiInvestValue').textContent = formatCurrency(investValue);
    root.querySelector('#wiCashHoldings').textContent = formatCurrency(cashHoldings);
    const changeEl = root.querySelector('#wiMonthlyChange');
    changeEl.textContent = `${totalDayChange >= 0 ? '+' : ''}${formatCurrency(totalDayChange)}`;
    changeEl.style.color = totalDayChange >= 0 ? '#16A34A' : '#EF4444';
    root.querySelector('#wiTotalAssets').textContent = formatCurrency(netWorth);

    const categoriesUsed = new Set(currentHoldings.map(holding => holding.category)).size;
    const cashPct = netWorth > 0 ? (cashHoldings / netWorth) * 100 : 100;
    let health = 50;
    if (currentHoldings.length > 0) {
      health += Math.min(20, categoriesUsed * 5);
      health += cashPct >= 10 && cashPct <= 30 ? 15 : -10;
      health += totalReturn >= 0 ? 10 : -10;
    }
    health = Math.max(0, Math.min(100, Math.round(health)));
    root.querySelector('#wiHealthScore').textContent = currentHoldings.length > 0 ? `${health} / 100` : 'Not enough data';

    const byCategory = {};
    Object.keys(categoryMeta).forEach(key => { byCategory[key] = 0; });
    byCategory.cash = cashHoldings;
    currentHoldings.forEach(holding => {
      if (holding.category !== 'cash') byCategory[holding.category] = (byCategory[holding.category] || 0) + Number(holding.value || 0);
    });
    const targetModel = { stocks: 40, etfs: 20, mutual_funds: 10, crypto: 5, cash: 15, bonds: 10 };
    root.querySelector('#wiAllocationRows').innerHTML = Object.keys(targetModel).map(key => {
      const val = byCategory[key] || 0;
      const pct = netWorth > 0 ? (val / netWorth) * 100 : 0;
      const label = key === 'bonds' ? 'Bonds' : (categoryMeta[key] ? categoryMeta[key].label : key);
      const color = key === 'bonds' ? '#64748B' : (categoryMeta[key] ? categoryMeta[key].color : '#64748B');
      return `
        <div>
          <div class="flex items-center justify-between mb-[4px]">
            <div class="flex items-center gap-[8px]"><span class="w-[8px] h-[8px] rounded-full flex-shrink-0" style="background:${color};"></span><span class="text-[12px] font-medium text-[#111827] dark:text-white">${label}</span></div>
            <span class="text-[12px] text-[#6B7280] dark:text-[#8E9CBA]">${formatCurrency(val)} · ${pct.toFixed(1)}% <span class="text-[10px]">(target ${targetModel[key]}%)</span></span>
          </div>
          <div class="w-full h-[6px] rounded-full bg-gray-100 dark:bg-white/10 overflow-hidden"><div class="h-full rounded-full" style="width:${Math.min(100, pct)}%; background:${color};"></div></div>
        </div>
      `;
    }).join('');
    const diversificationScore = currentHoldings.length > 0 ? Math.min(100, categoriesUsed * 18 + (cashPct >= 5 && cashPct <= 35 ? 10 : 0)) : 0;
    root.querySelector('#wiDiversificationScore').textContent = currentHoldings.length > 0 ? `${diversificationScore} / 100` : 'Not enough data';

    const risk = computeRiskProfile(currentHoldings, investValue);
    root.querySelector('#wiRiskLabel').textContent = risk.label;
    root.querySelector('#wiRiskMeter').style.width = `${risk.score}%`;
    root.querySelector('#wiConcentration').textContent = currentHoldings.length > 0 ? `${risk.concentrationPct.toFixed(0)}% in top holding` : 'Not enough data';
    const riskExplainers = {
      'No Holdings Yet': 'Add investments to see your personalized risk profile.',
      Conservative: 'Your portfolio is weighted toward stable, lower-volatility assets.',
      Moderate: 'Your portfolio balances stability with some growth exposure.',
      Balanced: 'Your portfolio has an even mix of growth and stability.',
      Growth: 'Your portfolio is weighted toward growth assets, with higher volatility.',
      Aggressive: 'Your portfolio is concentrated in higher-volatility assets like crypto and individual stocks.',
    };
    root.querySelector('#wiRiskExplainer').textContent = riskExplainers[risk.label] || '';

    const returnEl = root.querySelector('#wiTotalReturn');
    returnEl.textContent = `${totalReturn >= 0 ? '+' : ''}${formatCurrency(totalReturn)}`;
    returnEl.style.color = totalReturn >= 0 ? '#16A34A' : '#EF4444';
    root.querySelector('#wiIncomeGenerated').textContent = formatCurrency(totalDividends);

    const recs = generateRecommendations(currentHoldings, investValue, cashHoldings, risk);
    const priorityColor = { High: '#EF4444', Medium: '#F59E0B', Low: '#6B7280' };
    root.querySelector('#wiRecommendations').innerHTML = recs.map((rec, idx) => `
      <div class="bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[16px] p-[14px] shadow-lg">
        <div class="flex items-center justify-between mb-[4px]">
          <span class="text-[14px] font-bold text-[#111827] dark:text-white">${rec.title}</span>
          <span class="text-[10px] font-bold uppercase px-[8px] py-[2px] rounded-full" style="background:${priorityColor[rec.priority]}22; color:${priorityColor[rec.priority]};">${rec.priority}</span>
        </div>
        <div class="text-[12px] text-[#6B7280] dark:text-[#8E9CBA] mb-[8px]">${rec.action}</div>
        <div class="flex items-center justify-between">
          <span class="text-[11px] text-[#6B7280] dark:text-[#8E9CBA]">Estimated Impact: ${rec.impact}</span>
          ${rec.target ? `<button class="wi-rec-learn text-[12px] font-semibold text-[#2563EB] cursor-pointer" data-idx="${idx}">Learn More →</button>` : ''}
        </div>
      </div>
    `).join('');
    root.querySelectorAll('.wi-rec-learn').forEach(btn => {
      on(btn, 'click', () => {
        const rec = recs[parseInt(btn.getAttribute('data-idx'), 10)];
        if (rec && rec.target) rec.target();
      });
    });

    root.querySelector('#wiTaxDividends').textContent = formatCurrency(totalDividends);
    const gainsEl = root.querySelector('#wiUnrealizedGains');
    gainsEl.textContent = `${totalReturn >= 0 ? '+' : ''}${formatCurrency(totalReturn)}`;
    gainsEl.style.color = totalReturn >= 0 ? '#16A34A' : '#EF4444';
    const lossHoldings = currentHoldings.filter(holding => Number(holding.value) < Number(holding.cost_basis || holding.value));
    root.querySelector('#wiTaxLossOpps').textContent = lossHoldings.length > 0
      ? `${lossHoldings.length} holding(s) currently below cost basis: ${lossHoldings.map(holding => holding.symbol).join(', ')}.`
      : 'No tax-loss harvesting opportunities right now.';

    const alerts = [];
    if (risk.concentrationPct > 40) alerts.push({ icon: '⚠️', text: 'Portfolio drift: your top holding exceeds 40% concentration.' });
    if (cashPct > 25 && currentHoldings.length > 0) alerts.push({ icon: '💰', text: `Cash allocation (${cashPct.toFixed(0)}%) is above your target model.` });
    if (lossHoldings.length > 0) alerts.push({ icon: '📉', text: `${lossHoldings.length} holding(s) present a tax-loss harvesting opportunity.` });
    if (totalDividends > 0) alerts.push({ icon: '💵', text: `You've earned ${formatCurrency(totalDividends)} in dividend income so far.` });
    if (!alerts.length) alerts.push({ icon: '✅', text: 'No urgent alerts right now — your portfolio looks steady.' });
    root.querySelector('#wiAlertsList').innerHTML = alerts.map(alert => `
      <div class="bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[16px] p-[14px] shadow-lg flex items-center gap-[10px]">
        <span class="text-[18px] flex-shrink-0">${alert.icon}</span>
        <span class="text-[13px] text-[#111827] dark:text-white">${alert.text}</span>
      </div>
    `).join('');

    renderWealthGoals(await loadGoals());

    latestReport = {
      periodLabel: new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }),
      accountNumber: getAccountNumber('investments', 'account'),
      netWorth,
      investValue,
      cashHoldings,
      totalReturn,
      totalDividends,
      riskLabel: risk.label,
    };
  }

  on(root.querySelector('[data-action="close"]'), 'click', close);
  root.querySelectorAll('.wi-range-btn').forEach(btn => {
    on(btn, 'click', () => applyRangeButtonState(btn.getAttribute('data-range')));
  });
  applyRangeButtonState('1M');

  on(root.querySelector('#wiAddGoalBtn'), 'click', () => {
    root.querySelector('#wiGoalAddForm').classList.toggle('hidden');
  });
  on(root.querySelector('#wiSaveGoalBtn'), 'click', async () => {
    const wiGoalTarget = root.querySelector('#wiGoalTarget');
    const wiGoalCurrent = root.querySelector('#wiGoalCurrent');
    const wiGoalDate = root.querySelector('#wiGoalDate');
    const wiGoalError = root.querySelector('#wiGoalError');
    const wiSaveGoalBtn = root.querySelector('#wiSaveGoalBtn');
    const target = parseFloat(wiGoalTarget.value);

    wiGoalError.classList.add('hidden');
    if (!target || target <= 0) {
      wiGoalError.textContent = 'Please enter a valid target amount.';
      wiGoalError.classList.remove('hidden');
      return;
    }
    if (!supabaseClient) {
      wiGoalError.textContent = 'Goal tracking is unavailable right now.';
      wiGoalError.classList.remove('hidden');
      return;
    }

    wiSaveGoalBtn.disabled = true;
    wiSaveGoalBtn.textContent = 'Saving...';
    try {
      const user = await getCurrentUser();
      if (!user) throw new Error('Not signed in');
      const { error } = await supabaseClient.from('financial_goals').insert({
        user_id: user.id,
        goal_type: root.querySelector('#wiGoalType').value,
        target_amount: target,
        current_amount: parseFloat(wiGoalCurrent.value) || 0,
        target_date: wiGoalDate.value || null,
      });
      if (error) throw error;
      wiGoalTarget.value = '';
      wiGoalCurrent.value = '';
      wiGoalDate.value = '';
      wiSaveGoalBtn.disabled = false;
      wiSaveGoalBtn.textContent = 'Save Goal';
      root.querySelector('#wiGoalAddForm').classList.add('hidden');
      renderWealthGoals(await loadGoals());
    } catch (e) {
      console.error('Save goal error:', e);
      wiSaveGoalBtn.disabled = false;
      wiSaveGoalBtn.textContent = 'Save Goal';
      wiGoalError.textContent = 'Could not save this goal right now. Please try again.';
      wiGoalError.classList.remove('hidden');
    }
  });

  on(root.querySelector('#wiRebalanceBtn'), 'click', () => {
    showModal('Rebalance Portfolio', 'Automated rebalancing will be available once Buy & Sell Investments supports scheduled orders.');
  });
  on(root.querySelector('#wiScheduleAdvisorBtn'), 'click', () => loadPage('advisor'));
  on(root.querySelector('#wiViewPortfolioBtn'), 'click', () => loadPage('portfolio'));
  on(root.querySelector('#wiDownloadReportBtn'), 'click', openReportPrintView);
  on(root.querySelector('#wiReportCloseBtn'), 'click', () => root.querySelector('#wiReportPrintView').classList.add('hidden'));
  on(root.querySelector('#wiReportPrintBtn'), 'click', () => window.print());

  refreshInsights();
}

export function cleanup() {
  listeners.forEach(off => off());
  listeners = [];
}
