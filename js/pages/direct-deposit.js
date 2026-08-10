// Direct Deposit — Interest Checking "Direct Deposit" quick action. Shows
// the account's routing/account numbers and lets the user share/download/
// email/print a direct deposit authorization form, scoped to the account
// type passed in via loadPage('direct-deposit', type).

const accountLabels = {
  checking: 'Checking',
  interest_checking: 'Interest Checking',
  savings: 'Savings',
};

let listeners = [];
function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}

function openPrintableWindow(title, bodyHtml, autoPrint = false) {
  const win = window.open('', '_blank', 'noopener,noreferrer');
  if (!win) return;
  win.document.write(`<!doctype html><html><head><title>${title}</title><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;padding:32px;color:#111827}h1{font-size:20px;margin:0 0 16px}.row{display:flex;justify-content:space-between;margin:0 0 14px;font-size:14px}p{color:#6B7280;font-size:12px;line-height:1.5}</style></head><body>${bodyHtml}</body></html>`);
  win.document.close();
  if (autoPrint) setTimeout(() => win.print(), 250);
}

export function init(root, ctx, type = 'interest_checking') {
  const { close, getAccountNumber, showModal } = ctx;
  const label = accountLabels[type] || 'Checking';

  on(root.querySelector('[data-action="close"]'), 'click', close);

  root.querySelector('#ddAccountName').textContent = `${label} Direct Deposit`;
  root.querySelector('#ddAccountType').textContent = label;

  // The routing number is the bank's and is always available. The account
  // number is issued when the account is opened, so a form built before that
  // would send an employer a payment instruction with nowhere to send it —
  // the numbers row says so, and the form buttons stay off until there is one.
  const routing = getAccountNumber(type, 'routing');
  const accountNumber = getAccountNumber(type, 'account');
  root.querySelector('#ddRoutingNumber').textContent = routing;
  root.querySelector('#ddAccountNumber').textContent = accountNumber || ctx.NO_ACCOUNT_NUMBER_SHORT;

  if (!accountNumber) {
    const notice = document.createElement('div');
    notice.className = 'text-[12px] text-[#6B7280] dark:text-[#8E9CBA] leading-relaxed pt-[10px] mt-[6px] border-t border-gray-100 dark:border-white/[0.06]';
    notice.textContent = `${ctx.NO_ACCOUNT_NUMBER_TEXT}. Your routing number is already yours to share — the direct deposit form becomes available once your account number has been issued.`;
    root.querySelector('#ddAccountType').closest('.rounded-\\[22px\\]').appendChild(notice);

    ['#ddShareBtn', '#ddDownloadFormBtn', '#ddEmailFormBtn', '#ddPrintFormBtn'].forEach((sel) => {
      const btn = root.querySelector(sel);
      if (!btn) return;
      btn.disabled = true;
      btn.classList.add('opacity-50', 'cursor-not-allowed');
      btn.classList.remove('cursor-pointer');
    });
    const acctCopy = root.querySelector('.dd-copy[data-target="ddAccountNumber"]');
    if (acctCopy) acctCopy.remove();
  }

  function buildFormHtml() {
    return `
      <h1>Direct Deposit Authorization Form</h1>
      <div class="row"><span>Bank Name</span><strong>Verceil Bank</strong></div>
      <div class="row"><span>Routing Number</span><strong>${routing}</strong></div>
      <div class="row"><span>Account Number</span><strong>${accountNumber}</strong></div>
      <div class="row"><span>Account Type</span><strong>${label}</strong></div>
      <p>Provide this form to your employer or payer to set up direct deposit.</p>
    `;
  }

  root.querySelectorAll('.dd-copy').forEach((btn) => {
    on(btn, 'click', () => {
      const text = root.querySelector(`#${btn.getAttribute('data-target')}`)?.textContent || '';
      navigator.clipboard?.writeText(text).then(() => showModal('Copied', `${text} copied to clipboard.`)).catch(() => showModal('Copy', text));
    });
  });

  on(root.querySelector('#ddShareBtn'), 'click', async () => {
    const text = `Routing: ${routing} · ${label} Account: ${accountNumber}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Verceil Bank Direct Deposit Info', text });
      } catch (err) {
        console.error(err);
      }
    } else {
      showModal('Share Securely', "Secure sharing isn't supported on this browser.");
    }
  });

  on(root.querySelector('#ddDownloadFormBtn'), 'click', () => openPrintableWindow('Direct Deposit Form', buildFormHtml()));
  on(root.querySelector('#ddPrintFormBtn'), 'click', () => openPrintableWindow('Direct Deposit Form', buildFormHtml(), true));
  on(root.querySelector('#ddEmailFormBtn'), 'click', () => {
    const body = encodeURIComponent(`Direct Deposit Authorization\n\nBank Name: Verceil Bank\nRouting Number: ${routing}\nAccount Number: ${accountNumber}\nAccount Type: ${label}`);
    window.location.href = `mailto:?subject=${encodeURIComponent('Direct Deposit Form')}&body=${body}`;
  });
}

export function cleanup() {
  listeners.forEach((off) => off());
  listeners = [];
}
