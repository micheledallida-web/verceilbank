// Interest Details — Savings & Interest Checking "Interest Details" quick
// action. Shows APY, accrued/estimated interest, and a monthly interest
// payment history derived from the `transactions` table (credited entries
// tagged as interest).

const APY = 0.04;

const accountMeta = {
  savings: { name: 'High-Yield Savings', balanceId: 'savingsBalance' },
  interest_checking: { name: 'Vercel Interest Checking', balanceId: 'interestCheckingBalance' },
};

let listeners = [];
function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}

export async function init(root, ctx, type = 'savings') {
  const { supabaseClient, getCurrentUser, formatCurrency, parseBalanceText, close } = ctx;

  const meta = accountMeta[type] || accountMeta.savings;

  on(root.querySelector('[data-action="close"]'), 'click', close);

  root.querySelector('#idAccountName').textContent = `${meta.name} — Interest Details`;
  root.querySelector('#idApyLabel').textContent = `${meta.name.toUpperCase()} · ANNUAL PERCENTAGE YIELD`;

  const balance = parseBalanceText(document.getElementById(meta.balanceId)?.textContent || '0');
  root.querySelector('#idApyValue').textContent = `Up to ${(APY * 100).toFixed(2)}% APY`;
  root.querySelector('#idCurrentBalance').textContent = formatCurrency(balance);
  root.querySelector('#idMonthlyEarnings').textContent = formatCurrency((balance * APY) / 12);
  root.querySelector('#idAnnualEarnings').textContent = formatCurrency(balance * APY);

  const historyEl = root.querySelector('#idPaymentHistory');
  const ytdEl = root.querySelector('#idYtdEarnings');

  function renderHistory(payments) {
    if (!payments.length) {
      historyEl.className = 'bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[20px] px-[16px] shadow-lg py-4';
      historyEl.innerHTML = '<div class="text-center text-[14px] text-[#6B7280] dark:text-[#8E9CBA] py-2">No interest payments yet</div>';
      ytdEl.textContent = formatCurrency(0);
      return;
    }

    historyEl.className = 'bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[20px] px-[16px] shadow-lg divide-y divide-gray-100 dark:divide-white/[0.06]';
    historyEl.innerHTML = payments.map(tx => `
      <div class="flex items-center justify-between py-[12px]">
        <div>
          <div class="text-[14px] font-semibold text-[#111827] dark:text-white leading-tight">${tx.title || 'Interest Payment'}</div>
          <div class="text-[12px] font-normal text-[#6B7280] dark:text-[#8E9CBA] mt-0.5">${tx.date_info || ''}</div>
        </div>
        <div class="text-[14px] font-semibold text-[#16A34A] dark:text-[#22C55E]">+${formatCurrency(Math.abs(Number(tx.amount)))}</div>
      </div>
    `).join('');

    const ytdTotal = payments.reduce((sum, tx) => sum + Math.abs(Number(tx.amount) || 0), 0);
    ytdEl.textContent = formatCurrency(ytdTotal);
  }

  async function loadInterestHistory() {
    if (!supabaseClient) {
      renderHistory([]);
      return;
    }
    try {
      const user = await getCurrentUser();
      if (!user) {
        renderHistory([]);
        return;
      }

      const { data, error } = await supabaseClient
        .from('transactions')
        .select('*')
        .eq('user_id', user.id)
        .eq('account_type', type)
        .ilike('title', '%interest%')
        .order('created_at', { ascending: false });

      if (error) {
        renderHistory([]);
        return;
      }

      renderHistory(data || []);
    } catch (err) {
      console.error('Interest history fetch error:', err);
      renderHistory([]);
    }
  }

  loadInterestHistory();
}

export function cleanup() {
  listeners.forEach((off) => off());
  listeners = [];
}
