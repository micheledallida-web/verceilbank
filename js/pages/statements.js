let listeners = [];
function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}

export function init(root, ctx, options = null) {
  const { supabaseClient, getCurrentUser, formatCurrency, parseBalanceText, getAccountNumber, showModal, close } = ctx;

  const statementsList = root.querySelector('#statementsList');
  const generateStatementBtn = root.querySelector('#generateStatementBtn');
  const stmtDateFrom = root.querySelector('#stmtDateFrom');
  const stmtDateTo = root.querySelector('#stmtDateTo');
  const stmtActionsOverlay = root.querySelector('#stmtActionsOverlay');
  const stmtActionsSheet = root.querySelector('#stmtActionsSheet');
  const stmtActionsTitle = root.querySelector('#stmtActionsTitle');
  const statementPrintView = root.querySelector('#statementPrintView');
  const statementPrintMeta = root.querySelector('#statementPrintMeta');
  const statementPrintBody = root.querySelector('#statementPrintBody');

  const docTypeLabels = {
    portfolio_statement: 'Portfolio Statement',
    trade_confirmation: 'Trade Confirmation',
    dividend_statement: 'Dividend Statement',
    capital_gains: 'Capital Gains Report',
    cost_basis: 'Cost Basis Report',
    tax_form: 'Tax Form',
  };

  let currentStatements = [];
  let activeStmtPeriod = 'monthly';
  let activeStmtDoc = 'all';
  let activeStatementForActions = null;

  function applyPeriodTabState(period) {
    root.querySelectorAll('.stmt-tab').forEach(btn => {
      btn.classList.remove('bg-[#2563EB]', 'text-white', 'bg-white', 'dark:bg-[#0D1728]', 'text-[#111827]', 'dark:text-white');
      if (btn.getAttribute('data-period') === period) btn.classList.add('bg-[#2563EB]', 'text-white');
      else btn.classList.add('bg-white', 'dark:bg-[#0D1728]', 'text-[#111827]', 'dark:text-white');
    });
  }

  function applyDocChipState(docType) {
    root.querySelectorAll('.stmt-doc-chip').forEach(btn => {
      btn.classList.remove('bg-[#2563EB]', 'text-white', 'bg-white', 'dark:bg-[#0D1728]', 'text-[#111827]', 'dark:text-white');
      if (btn.getAttribute('data-doc') === docType) btn.classList.add('bg-[#2563EB]', 'text-white');
      else btn.classList.add('bg-white', 'dark:bg-[#0D1728]', 'text-[#111827]', 'dark:text-white');
    });
  }

  async function loadStatements() {
    if (!supabaseClient) return [];
    try {
      const user = await getCurrentUser();
      if (!user) return [];
      const { data, error } = await supabaseClient
        .from('investment_statements')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (e) {
      console.error('Load statements error:', e);
      return [];
    }
  }

  function openStatementPrintView(stmt) {
    statementPrintMeta.textContent = `${docTypeLabels[stmt.doc_type] || stmt.doc_type} · ${stmt.statement_period} · Account ending •${stmt.account_number ? String(stmt.account_number).slice(-4) : '----'}`;
    statementPrintBody.innerHTML = `
      <div style="display:flex;justify-content:space-between;margin-bottom:16px;"><span>Statement Period</span><strong>${stmt.statement_period}</strong></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:16px;"><span>Account Number</span><strong>${stmt.account_number || '—'}</strong></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:16px;"><span>Ending Balance</span><strong>${formatCurrency(stmt.ending_balance || 0)}</strong></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:16px;"><span>Document Type</span><strong>${docTypeLabels[stmt.doc_type] || stmt.doc_type}</strong></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:16px;"><span>Generated</span><strong>${new Date(stmt.created_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</strong></div>
      <p style="color:#6B7280;font-size:12px;margin-top:24px;">This is a system-generated summary based on your account records at the time of generation. It is not a substitute for an official audited statement.</p>
    `;
    statementPrintView.classList.remove('hidden');
  }

  function openStatementActionsSheet(stmt) {
    activeStatementForActions = stmt;
    stmtActionsTitle.textContent = `${docTypeLabels[stmt.doc_type] || stmt.doc_type} — ${stmt.statement_period}`;
    stmtActionsOverlay.classList.remove('hidden');
    stmtActionsSheet.classList.remove('hidden');
  }

  function closeStatementActionsSheet() {
    stmtActionsOverlay.classList.add('hidden');
    stmtActionsSheet.classList.add('hidden');
  }

  function renderStatements() {
    let filtered = currentStatements.filter(stmt => stmt.period_type === activeStmtPeriod);
    if (activeStmtDoc !== 'all') filtered = filtered.filter(stmt => stmt.doc_type === activeStmtDoc);
    if (stmtDateFrom.value) filtered = filtered.filter(stmt => new Date(stmt.created_at) >= new Date(stmtDateFrom.value));
    if (stmtDateTo.value) filtered = filtered.filter(stmt => new Date(stmt.created_at) <= new Date(`${stmtDateTo.value}T23:59:59`));

    if (!filtered.length) {
      statementsList.innerHTML = '<div class="bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[20px] px-[16px] shadow-lg py-4"><div class="text-center text-[14px] text-[#6B7280] dark:text-[#8E9CBA] py-2">No statements match your filters.</div></div>';
      return;
    }

    statementsList.innerHTML = filtered.map(stmt => `
      <div class="w-full bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[18px] p-[14px] shadow-lg flex items-center justify-between">
        <div class="min-w-0">
          <div class="text-[14px] font-bold text-[#111827] dark:text-white">${docTypeLabels[stmt.doc_type] || stmt.doc_type}</div>
          <div class="text-[12px] text-[#6B7280] dark:text-[#8E9CBA]">${stmt.statement_period}</div>
          <div class="text-[12px] text-[#6B7280] dark:text-[#8E9CBA]">Acct •${stmt.account_number ? String(stmt.account_number).slice(-4) : '----'} · Ending ${formatCurrency(stmt.ending_balance || 0)}</div>
        </div>
        <button class="stmt-open-actions w-[40px] h-[40px] rounded-full bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 flex items-center justify-center text-[#2563EB] cursor-pointer flex-shrink-0" data-id="${stmt.id}" aria-label="Statement actions">
          <svg class="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"></path></svg>
        </button>
      </div>
    `).join('');

    statementsList.querySelectorAll('.stmt-open-actions').forEach(btn => {
      on(btn, 'click', () => {
        const stmt = currentStatements.find(entry => String(entry.id) === btn.getAttribute('data-id'));
        if (stmt) openStatementActionsSheet(stmt);
      });
    });
  }

  async function refreshStatements() {
    statementsList.innerHTML = '<div class="text-center text-[13px] text-white/70 py-4">Loading...</div>';
    currentStatements = await loadStatements();
    renderStatements();
    if (options && options.autoOpenPrint) openStatementPrintView(options.autoOpenPrint);
  }

  on(root.querySelector('[data-action="close"]'), 'click', close);
  on(stmtDateFrom, 'change', renderStatements);
  on(stmtDateTo, 'change', renderStatements);
  on(root.querySelector('#stmtDateClearBtn'), 'click', () => {
    stmtDateFrom.value = '';
    stmtDateTo.value = '';
    renderStatements();
  });
  on(stmtActionsOverlay, 'click', closeStatementActionsSheet);
  on(root.querySelector('#stmtActionsCancel'), 'click', closeStatementActionsSheet);
  on(root.querySelector('#statementPrintCloseBtn'), 'click', () => statementPrintView.classList.add('hidden'));
  on(root.querySelector('#statementPrintNowBtn'), 'click', () => window.print());
  on(root.querySelector('#stmtActionDownload'), 'click', () => {
    if (!activeStatementForActions) return;
    closeStatementActionsSheet();
    openStatementPrintView(activeStatementForActions);
  });
  on(root.querySelector('#stmtActionPrint'), 'click', () => {
    if (!activeStatementForActions) return;
    closeStatementActionsSheet();
    openStatementPrintView(activeStatementForActions);
    setTimeout(() => window.print(), 300);
  });
  on(root.querySelector('#stmtActionEmail'), 'click', () => {
    if (!activeStatementForActions) return;
    const stmt = activeStatementForActions;
    closeStatementActionsSheet();
    const subject = encodeURIComponent(`${docTypeLabels[stmt.doc_type] || stmt.doc_type} — ${stmt.statement_period}`);
    const body = encodeURIComponent(
      `Verceil Bank — Investment Statement\n\nStatement Period: ${stmt.statement_period}\nAccount Number: ${stmt.account_number || '—'}\nEnding Balance: ${formatCurrency(stmt.ending_balance || 0)}\nDocument Type: ${docTypeLabels[stmt.doc_type] || stmt.doc_type}\n\nThis is a system-generated summary and not a substitute for an official audited statement.`
    );
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  });
  on(root.querySelector('#stmtActionShare'), 'click', async () => {
    if (!activeStatementForActions) return;
    const stmt = activeStatementForActions;
    closeStatementActionsSheet();
    const shareText = `${docTypeLabels[stmt.doc_type] || stmt.doc_type} — ${stmt.statement_period} — Ending balance ${formatCurrency(stmt.ending_balance || 0)}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Verceil Bank Statement', text: shareText });
      } catch (e) {}
    } else {
      showModal('Share Securely', 'Secure sharing isn\'t supported on this browser. Try Download PDF instead and share the file directly.');
    }
  });
  on(root.querySelector('#stmtActionOfficial'), 'click', async () => {
    if (!activeStatementForActions) return;
    const stmt = activeStatementForActions;
    closeStatementActionsSheet();
    try {
      if (!supabaseClient) throw new Error('Supabase client not available');
      const user = await getCurrentUser();
      if (!user) throw new Error('Not signed in');
      await supabaseClient.from('investment_statements').update({ official_copy_requested: true }).eq('id', stmt.id);
    } catch (e) {
      console.error('Request official copy error:', e);
    }
    showModal('Official Copy Requested', 'Your request for a certified official copy has been submitted. Expect it by mail within 5–7 business days.');
  });

  root.querySelectorAll('.stmt-tab').forEach(btn => {
    on(btn, 'click', () => {
      activeStmtPeriod = btn.getAttribute('data-period') || 'monthly';
      applyPeriodTabState(activeStmtPeriod);
      renderStatements();
    });
  });
  root.querySelectorAll('.stmt-doc-chip').forEach(btn => {
    on(btn, 'click', () => {
      activeStmtDoc = btn.getAttribute('data-doc') || 'all';
      applyDocChipState(activeStmtDoc);
      renderStatements();
    });
  });
  applyPeriodTabState(activeStmtPeriod);
  applyDocChipState(activeStmtDoc);

  on(generateStatementBtn, 'click', async () => {
    if (!supabaseClient) {
      showModal('Could Not Generate', 'This statement could not be generated right now. Please try again.');
      return;
    }
    generateStatementBtn.disabled = true;
    generateStatementBtn.textContent = 'Generating...';
    try {
      const user = await getCurrentUser();
      if (!user) throw new Error('Not signed in');
      const endingBalance = parseBalanceText(document.getElementById('investmentsBalance')?.textContent || '$0.00');
      const acctNum = getAccountNumber('investments', 'account') || '';
      const now = new Date();
      const periodLabels = {
        monthly: now.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
        quarterly: `Q${Math.floor(now.getMonth() / 3) + 1} ${now.getFullYear()}`,
        annual: `${now.getFullYear()}`,
        tax: `Tax Year ${now.getFullYear()}`,
      };
      const docType = activeStmtPeriod === 'tax' ? 'tax_form' : 'portfolio_statement';
      const { error } = await supabaseClient.from('investment_statements').insert({
        user_id: user.id,
        period_type: activeStmtPeriod,
        doc_type: docType,
        statement_period: periodLabels[activeStmtPeriod],
        account_number: acctNum,
        ending_balance: endingBalance,
      });
      if (error) throw error;

      generateStatementBtn.disabled = false;
      generateStatementBtn.textContent = '+ Generate Statement for Current Period';
      await refreshStatements();
    } catch (e) {
      console.error('Generate statement error:', e);
      generateStatementBtn.disabled = false;
      generateStatementBtn.textContent = '+ Generate Statement for Current Period';
      showModal('Could Not Generate', 'This statement could not be generated right now. Please try again.');
    }
  });

  refreshStatements();
}

export function cleanup() {
  listeners.forEach(off => off());
  listeners = [];
}
