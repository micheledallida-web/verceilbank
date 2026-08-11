import { showReceipt } from '../shared/receipt.js';

let listeners = [];
function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}

export function init(root, ctx, side = 'buy', prefill = null) {
  const { supabaseClient, getCurrentUser, genRef, formatCurrency, parseBalanceText, close } = ctx;

  const formStep = root.querySelector('#tradeFormStep');
  const reviewStep = root.querySelector('#tradeReviewStep');
  const tradeTabBuy = root.querySelector('#tradeTabBuy');
  const tradeTabSell = root.querySelector('#tradeTabSell');
  const tradeSymbol = root.querySelector('#tradeSymbol');
  const tradeHoldingInfo = root.querySelector('#tradeHoldingInfo');
  const tradeName = root.querySelector('#tradeName');
  const tradeShares = root.querySelector('#tradeShares');
  const tradePrice = root.querySelector('#tradePrice');
  const tradeOrderType = root.querySelector('#tradeOrderType');
  const tradeDuration = root.querySelector('#tradeDuration');
  const tradeEstimatedTotal = root.querySelector('#tradeEstimatedTotal');
  const tradeBuyingPower = root.querySelector('#tradeBuyingPower');
  const tradeFormError = root.querySelector('#tradeFormError');
  const tradeReviewRows = root.querySelector('#tradeReviewRows');
  const tradeReviewError = root.querySelector('#tradeReviewError');
  const tradeReviewBtn = root.querySelector('#tradeReviewBtn');
  const tradeSubmitBtn = root.querySelector('#tradeSubmitBtn');

  let currentHoldings = [];
  let tradeSide = 'buy';
  let pendingTrade = null;

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

  function setTradeTab(nextSide) {
    tradeSide = nextSide;
    [tradeTabBuy, tradeTabSell].forEach(btn => {
      btn.classList.remove('bg-[#2563EB]', 'text-white', 'bg-white', 'dark:bg-[#0D1728]', 'text-[#111827]', 'dark:text-white', 'border', 'border-gray-200', 'dark:border-white/10');
    });
    const active = nextSide === 'buy' ? tradeTabBuy : tradeTabSell;
    const inactive = nextSide === 'buy' ? tradeTabSell : tradeTabBuy;
    active.classList.add('bg-[#2563EB]', 'text-white');
    inactive.classList.add('bg-white', 'dark:bg-[#0D1728]', 'text-[#111827]', 'dark:text-white', 'border', 'border-gray-200', 'dark:border-white/10');
    tradeReviewBtn.textContent = nextSide === 'buy' ? 'Review Buy Order' : 'Review Sell Order';
    updateTradeEstimate();
  }

  function updateTradeEstimate() {
    const shares = parseFloat(tradeShares.value) || 0;
    const price = parseFloat(tradePrice.value) || 0;
    tradeEstimatedTotal.textContent = formatCurrency(shares * price);
  }

  function updateHoldingInfo() {
    const symbol = tradeSymbol.value.trim().toUpperCase();
    if (!symbol) {
      tradeHoldingInfo.classList.add('hidden');
      return;
    }
    const held = currentHoldings.find(h => (h.symbol || '').toUpperCase() === symbol);
    if (held) {
      tradeName.value = tradeName.value.trim() || held.name || symbol;
      tradeHoldingInfo.textContent = `You currently hold ${held.shares} shares (${formatCurrency(held.value)})`;
      tradeHoldingInfo.classList.remove('hidden');
    } else {
      tradeHoldingInfo.classList.add('hidden');
    }
  }

  function applyPrefill(data) {
    if (!data || typeof data !== 'object') return;
    if (data.symbol) tradeSymbol.value = String(data.symbol).toUpperCase();
    if (data.name) tradeName.value = data.name;
    if (data.price) tradePrice.value = data.price;
    if (data.shares) tradeShares.value = data.shares;
    updateHoldingInfo();
    updateTradeEstimate();
  }

  async function initializeTradeForm() {
    currentHoldings = await loadHoldings();
    tradeSymbol.value = '';
    tradeName.value = '';
    tradeShares.value = '';
    tradePrice.value = '';
    tradeOrderType.value = 'market';
    tradeDuration.value = 'day';
    tradeHoldingInfo.classList.add('hidden');
    tradeFormError.classList.add('hidden');
    tradeReviewError.classList.add('hidden');
    tradeBuyingPower.textContent = document.getElementById('savingsBalance')?.textContent || '$0.00';
    formStep.classList.remove('hidden');
    reviewStep.classList.add('hidden');
    setTradeTab(side === 'sell' ? 'sell' : 'buy');
    applyPrefill(prefill);
  }

  on(root.querySelector('[data-action="close"]'), 'click', close);
  on(root.querySelector('[data-action="back-to-form"]'), 'click', () => {
    reviewStep.classList.add('hidden');
    formStep.classList.remove('hidden');
  });
  on(tradeTabBuy, 'click', () => setTradeTab('buy'));
  on(tradeTabSell, 'click', () => setTradeTab('sell'));
  on(tradeShares, 'input', updateTradeEstimate);
  on(tradePrice, 'input', updateTradeEstimate);
  on(tradeSymbol, 'blur', updateHoldingInfo);

  on(tradeReviewBtn, 'click', () => {
    tradeFormError.classList.add('hidden');
    const symbol = tradeSymbol.value.trim().toUpperCase();
    const name = tradeName.value.trim() || symbol;
    const shares = parseFloat(tradeShares.value);
    const price = parseFloat(tradePrice.value);

    if (!symbol) {
      tradeFormError.textContent = 'Please enter a symbol.';
      tradeFormError.classList.remove('hidden');
      return;
    }
    if (!shares || shares <= 0 || !price || price <= 0) {
      tradeFormError.textContent = 'Please enter valid shares and price.';
      tradeFormError.classList.remove('hidden');
      return;
    }

    const total = shares * price;
    const held = currentHoldings.find(h => (h.symbol || '').toUpperCase() === symbol);

    if (tradeSide === 'sell') {
      if (!held || Number(held.shares) < shares) {
        tradeFormError.textContent = `You don't have enough shares of ${symbol} to sell.`;
        tradeFormError.classList.remove('hidden');
        return;
      }
    } else {
      const available = parseBalanceText(document.getElementById('savingsBalance')?.textContent || '$0.00');
      if (total > available) {
        tradeFormError.textContent = 'Insufficient funds in High-Yield Savings for this order.';
        tradeFormError.classList.remove('hidden');
        return;
      }
    }

    pendingTrade = {
      side: tradeSide,
      symbol,
      name,
      shares,
      price,
      total,
      orderType: tradeOrderType.value,
      duration: tradeDuration.value,
      heldRow: held || null,
      ref: genRef(),
    };

    tradeReviewRows.innerHTML = `
      <div class="flex items-center justify-between py-[12px]"><span class="text-[13px] text-[#6B7280] dark:text-[#8E9CBA]">Investment</span><span class="text-[14px] font-semibold text-[#111827] dark:text-white">${symbol} — ${name}</span></div>
      <div class="flex items-center justify-between py-[12px]"><span class="text-[13px] text-[#6B7280] dark:text-[#8E9CBA]">Side</span><span class="text-[14px] font-semibold text-[#111827] dark:text-white">${tradeSide === 'buy' ? 'Buy' : 'Sell'}</span></div>
      <div class="flex items-center justify-between py-[12px]"><span class="text-[13px] text-[#6B7280] dark:text-[#8E9CBA]">Order Type</span><span class="text-[14px] font-semibold text-[#111827] dark:text-white">${tradeOrderType.options[tradeOrderType.selectedIndex].text} · ${tradeDuration.options[tradeDuration.selectedIndex].text}</span></div>
      <div class="flex items-center justify-between py-[12px]"><span class="text-[13px] text-[#6B7280] dark:text-[#8E9CBA]">Quantity</span><span class="text-[14px] font-semibold text-[#111827] dark:text-white">${shares} shares @ ${formatCurrency(price)}</span></div>
      <div class="flex items-center justify-between py-[12px]"><span class="text-[13px] text-[#6B7280] dark:text-[#8E9CBA]">Estimated Total</span><span class="text-[16px] font-bold text-[#111827] dark:text-white">${formatCurrency(total)}</span></div>
      <div class="flex items-center justify-between py-[12px]"><span class="text-[13px] text-[#6B7280] dark:text-[#8E9CBA]">Funding Account</span><span class="text-[14px] font-semibold text-[#111827] dark:text-white">High-Yield Savings</span></div>
    `;
    formStep.classList.add('hidden');
    reviewStep.classList.remove('hidden');
  });

  on(tradeSubmitBtn, 'click', async () => {
    if (!pendingTrade) return;
    tradeReviewError.classList.add('hidden');
    tradeSubmitBtn.disabled = true;
    tradeSubmitBtn.textContent = 'Processing...';

    try {
      if (!supabaseClient) throw new Error('Supabase client not available');
      const user = await getCurrentUser();
      if (!user) throw new Error('Not signed in');

      const { error } = await supabaseClient.from('investment_orders').insert({
        user_id: user.id,
        symbol: pendingTrade.symbol,
        company_name: pendingTrade.name,
        order_type: pendingTrade.orderType,
        side: pendingTrade.side,
        quantity: pendingTrade.shares,
        price: pendingTrade.price,
        total: pendingTrade.total,
        duration: pendingTrade.duration,
        status: 'submitted',
        confirmation_number: pendingTrade.ref,
      });
      if (error) throw error;

      // A buy takes cash out of the investment account and a sell puts it
      // back, so the sign follows the side of the order. Pending, because an
      // order is submitted to a market rather than settled on the spot.
      ctx.recordTransaction({
        accountType: 'investments',
        amount: pendingTrade.side === 'buy' ? -Math.abs(pendingTrade.total) : Math.abs(pendingTrade.total),
        title: `${pendingTrade.side === 'buy' ? 'Buy' : 'Sell'} ${pendingTrade.shares} ${pendingTrade.symbol}`,
        iconText: pendingTrade.side === 'buy' ? '↑' : '↓',
        category: 'trade',
        reference: pendingTrade.ref,
        status: 'pending',
      });

      if (pendingTrade.side === 'buy') {
        if (pendingTrade.heldRow) {
          const newShares = Number(pendingTrade.heldRow.shares) + pendingTrade.shares;
          const newValue = Number(pendingTrade.heldRow.value) + pendingTrade.total;
          const newCostBasis = Number(pendingTrade.heldRow.cost_basis || 0) + pendingTrade.total;
          await supabaseClient.from('investment_portfolio').update({
            shares: newShares,
            value: newValue,
            cost_basis: newCostBasis,
            price: pendingTrade.price,
          }).eq('id', pendingTrade.heldRow.id);
        } else {
          await supabaseClient.from('investment_portfolio').insert({
            user_id: user.id,
            symbol: pendingTrade.symbol,
            name: pendingTrade.name,
            category: 'stocks',
            shares: pendingTrade.shares,
            price: pendingTrade.price,
            value: pendingTrade.total,
            cost_basis: pendingTrade.total,
            day_change: 0,
            dividend_income: 0,
          });
        }
        const fundingEl = document.getElementById('savingsBalance');
        const investmentsEl = document.getElementById('investmentsBalance');
        if (fundingEl) fundingEl.textContent = formatCurrency(parseBalanceText(fundingEl.textContent) - pendingTrade.total);
        if (investmentsEl) investmentsEl.textContent = formatCurrency(parseBalanceText(investmentsEl.textContent) + pendingTrade.total);
      } else {
        const remainingShares = Number(pendingTrade.heldRow.shares) - pendingTrade.shares;
        if (remainingShares <= 0) {
          await supabaseClient.from('investment_portfolio').delete().eq('id', pendingTrade.heldRow.id);
        } else {
          const proportion = remainingShares / Number(pendingTrade.heldRow.shares);
          await supabaseClient.from('investment_portfolio').update({
            shares: remainingShares,
            value: Number(pendingTrade.heldRow.value) - pendingTrade.total,
            cost_basis: Number(pendingTrade.heldRow.cost_basis || 0) * proportion,
          }).eq('id', pendingTrade.heldRow.id);
        }
        const fundingEl = document.getElementById('savingsBalance');
        const investmentsEl = document.getElementById('investmentsBalance');
        if (fundingEl) fundingEl.textContent = formatCurrency(parseBalanceText(fundingEl.textContent) + pendingTrade.total);
        if (investmentsEl) investmentsEl.textContent = formatCurrency(Math.max(0, parseBalanceText(investmentsEl.textContent) - pendingTrade.total));
      }

      tradeSubmitBtn.disabled = false;
      tradeSubmitBtn.textContent = 'Submit Order';
      const completedTrade = pendingTrade;
      pendingTrade = null;
      close();
      showReceipt({
        amount: formatCurrency(completedTrade.total),
        recipient: `${completedTrade.side === 'buy' ? 'Bought' : 'Sold'} ${completedTrade.shares} ${completedTrade.symbol}`,
        confirmation: completedTrade.ref,
      });
    } catch (e) {
      console.error('Trade submit error:', e);
      tradeSubmitBtn.disabled = false;
      tradeSubmitBtn.textContent = 'Submit Order';
      tradeReviewError.textContent = 'This order could not be submitted. Please try again.';
      tradeReviewError.classList.remove('hidden');
    }
  });

  initializeTradeForm();
}

export function cleanup() {
  listeners.forEach(off => off());
  listeners = [];
}
