// Joint Accounts — Accounts > Joint Accounts, and Invest > Joint Accounts.
//
// The screen exists to answer one question honestly: how do I put somebody else
// on my account? The answer is that you cannot do it here, and that is not a
// missing feature.
//
// A joint owner has the same rights over the money as the person who opened the
// account — they can empty it, they can close it, and their creditors can reach
// it. Every bank puts a person between a customer and that decision: both
// owners identified, both signatures on the ownership agreement, and somebody
// on the phone who can hear when a request does not sound like it is being made
// freely. So this screen tells the customer to call customer care or email
// support, tells them what will be asked for, tells them what they are actually
// agreeing to, and shows them where they stand against the sixty-day rule.

import {
  ACCOUNT_PRODUCTS_BY_KEY,
  JOINT_OWNER_MIN_DAYS,
  SUPPORT_PHONE,
  SUPPORT_PHONE_DISPLAY,
  SUPPORT_HOURS,
  readJointOwnerEligibility,
} from '../shared/account-products.js';

const REQUIREMENTS = [
  ['The other owner\'s full legal name', 'Exactly as it appears on their government ID'],
  ['Their date of birth and Social Security number', 'They are identity-checked the same way you were'],
  ['Their address, phone number and email', 'We contact them directly to confirm they agree'],
  ['Both signatures on the ownership agreement', 'Sent to you both once the identity checks clear'],
];

const CONSIDERATIONS = [
  ['They can withdraw all of it', 'A joint owner needs no permission from you to move or spend the money.'],
  ['Their debts can reach it', 'A creditor or a court order against either owner can be enforced against the whole balance.'],
  ['Removing them needs both of you', 'In most cases the account is closed and reopened in a single name.'],
  ['It affects both of your records', 'Overdrafts and account history belong to both owners, not just the one who caused them.'],
];

let listeners = [];
function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}

function rows(items, accent) {
  return items.map(([label, detail], idx) => `
    <div class="flex items-start gap-[10px] py-[10px]${idx > 0 ? ' border-t border-gray-100 dark:border-white/[0.06]' : ''}">
      <svg class="mt-[3px] flex-shrink-0" style="color:${accent};width:14px;height:14px;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>
      <span class="min-w-0">
        <span class="block text-[13px] font-medium text-[#111827] dark:text-white leading-snug">${label}</span>
        <span class="block text-[12px] text-[#6B7280] dark:text-[#8E9CBA] mt-[2px] leading-relaxed">${detail}</span>
      </span>
    </div>
  `).join('');
}

export function init(root, ctx) {
  const { close, loadPage, supabaseClient, getCurrentUser, formatCurrency, openSupportMessage } = ctx;

  on(root.querySelector('[data-action="close"]'), 'click', close);

  root.querySelector('#jaCallNumber').textContent = `${SUPPORT_PHONE_DISPLAY} · ${SUPPORT_HOURS}`;
  root.querySelector('#jaCallBtn').setAttribute('href', `tel:${SUPPORT_PHONE}`);
  root.querySelector('#jaRequirements').innerHTML = rows(REQUIREMENTS, '#2563EB');
  root.querySelector('#jaConsiderations').innerHTML = rows(CONSIDERATIONS, '#8B5CF6');

  on(root.querySelector('#jaOpenAccountBtn'), 'click', () => loadPage('open-account'));

  on(root.querySelector('#jaEmailBtn'), 'click', () => {
    ctx.recordEvent('joint_account.support_requested', {});
    openSupportMessage({
      category: 'account_ownership',
      subject: 'Add a joint owner to my account',
      body: 'I would like to add a joint owner to my account. Please tell me which of my accounts is eligible, '
        + 'what you need from the other owner, and send us the ownership agreement to sign.',
    });
  });

  // ---------- The sixty-day rule ----------
  // Stated as where this customer stands, not as a policy read at them. The
  // number of days left is the thing they came here to find out.
  function renderEligibility(state) {
    const icon = root.querySelector('#jaEligibilityIcon');
    const title = root.querySelector('#jaEligibilityTitle');
    const body = root.querySelector('#jaEligibilityBody');
    const meter = root.querySelector('#jaEligibilityMeter');
    const fill = root.querySelector('#jaEligibilityFill');
    const meterLabel = root.querySelector('#jaEligibilityMeterLabel');
    const note = root.querySelector('#jaContactNoteBody');

    note.textContent = `Adding a joint owner is arranged over the phone or by message with support — call customer care on ${SUPPORT_PHONE_DISPLAY}, or send us a message and we will reply with what we need from both of you.`;

    // An unknown join date says what the rule is and stops there. It does not
    // guess in the customer's favour: being told they qualify and then being
    // refused on the phone is worse than being told to ask.
    if (!state.known) {
      title.textContent = `Available after ${JOINT_OWNER_MIN_DAYS} days`;
      body.textContent = `A joint owner can be added to an account once it has been held for ${JOINT_OWNER_MIN_DAYS} days. Customer care will confirm where you stand.`;
      meter.classList.add('hidden');
      return;
    }

    if (state.eligible) {
      icon.className = 'w-[34px] h-[34px] rounded-full flex items-center justify-center flex-shrink-0 bg-emerald-100 dark:bg-[#10B981]/20 text-emerald-700 dark:text-[#10B981]';
      icon.innerHTML = '<svg class="w-[17px] h-[17px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.6"><polyline points="20 6 9 17 4 12"></polyline></svg>';
      title.textContent = 'You can add a joint owner';
      body.textContent = `You have banked with us for ${state.daysHeld} days, past the ${JOINT_OWNER_MIN_DAYS} days an account has to be held first. Call customer care or send us a message to start.`;
      meter.classList.add('hidden');
      return;
    }

    const days = state.daysRemaining;
    title.textContent = `Available on ${state.eligibleOn}`;
    body.textContent = `A joint owner can be added once an account has been held for ${JOINT_OWNER_MIN_DAYS} days. You have held yours for ${state.daysHeld}, so there ${days === 1 ? 'is 1 day' : `are ${days} days`} to go.`;

    const pct = Math.max(0, Math.min(100, Math.round((state.daysHeld / JOINT_OWNER_MIN_DAYS) * 100)));
    fill.style.width = `${pct}%`;
    meterLabel.textContent = `Day ${state.daysHeld} of ${JOINT_OWNER_MIN_DAYS}`;
    meter.classList.remove('hidden');
  }

  // ---------- Joint accounts already held ----------
  // Opened for this customer by a representative, so they are read from the
  // record rather than assumed: the column is written when the ownership
  // agreement is countersigned.
  function renderJointAccounts(accounts) {
    const section = root.querySelector('#jaAccountsSection');
    const list = root.querySelector('#jaAccountsList');
    if (!accounts.length) {
      section.classList.add('hidden');
      return;
    }

    list.innerHTML = accounts.map((row) => {
      const product = ACCOUNT_PRODUCTS_BY_KEY[row.account_type];
      const name = product ? product.name : 'Joint Account';
      return `
        <div class="bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[20px] p-[16px] shadow-lg">
          <div class="flex items-center justify-between gap-[12px]">
            <div class="min-w-0">
              <div class="text-[14px] font-semibold text-[#111827] dark:text-white">${name}</div>
              <div class="text-[12px] text-[#6B7280] dark:text-[#8E9CBA] mt-[2px]">Jointly owned</div>
            </div>
            <div class="text-[18px] font-bold text-[#111827] dark:text-white flex-shrink-0">${formatCurrency(row.balance || 0)}</div>
          </div>
        </div>
      `;
    }).join('');

    section.classList.remove('hidden');
  }

  async function readJointAccounts() {
    if (!supabaseClient) return [];
    try {
      const user = await getCurrentUser();
      if (!user) return [];
      const { data, error } = await supabaseClient
        .from('accounts')
        .select('account_type, balance, ownership')
        .eq('user_id', user.id)
        .eq('ownership', 'joint');
      // `ownership` is written by the bank when a joint agreement is
      // countersigned, and a project that has not added the column yet answers
      // with an error rather than rows. That is not a failure worth showing
      // anybody: nobody holds a joint account on such a project, which is
      // exactly what an empty list says.
      if (error) return [];
      return data || [];
    } catch (err) {
      return [];
    }
  }

  async function load() {
    const [eligibility, jointAccounts] = await Promise.all([
      readJointOwnerEligibility({ supabaseClient, getCurrentUser }),
      readJointAccounts(),
    ]);
    renderEligibility(eligibility);
    renderJointAccounts(jointAccounts);
  }

  load();
}

export function cleanup() {
  listeners.forEach((off) => off());
  listeners = [];
}
