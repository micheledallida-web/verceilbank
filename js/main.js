// ==================== CORE APP MODULE ====================
// This file is the ONLY thing loaded on initial page load.
// Every individual screen (Send Money, Transfer, Portfolio, etc.) is loaded
// on demand via loadPage() — its HTML fragment is fetched, its JS module is
// dynamically imported, and both are torn down again when the page closes.
// This is what actually makes the app fast: the browser only ever downloads
// and parses the one screen someone is looking at.

import { createLiveSparkline } from './shared/live-sparkline.js';

// Populated by js/config.js (generated at build time from SUPABASE_URL /
// SUPABASE_ANON_KEY env vars -- see scripts/generate-config.js). js/config.js
// is loaded as a plain script in dashboard.html, before this module.
export const SUPABASE_URL = window.SUPABASE_URL;
export const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;

export let supabaseClient = null;
try {
  if (window.supabase) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
} catch (err) {
  console.error('Supabase init error:', err);
}

// ---------- Shared helpers (used by every page module) ----------
export async function getCurrentUser() {
  if (!supabaseClient) return null;
  const { data: { session } } = await supabaseClient.auth.getSession();
  return session && session.user ? session.user : null;
}

export function genRef() {
  return 'VB-' + Math.random().toString(36).slice(2, 10).toUpperCase();
}

// The sign goes outside the symbol — "-$45.50", not "$-45.50", which is how
// every US bank writes an overdraft and the only form people read at a glance.
export function formatCurrency(n) {
  // Rounded to cents before the sign is read, so a value that is fractionally
  // below zero renders as "$0.00" rather than a negative zero.
  const cents = Math.round((Number(n) || 0) * 100);
  const digits = (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${cents < 0 ? '-' : ''}$${digits}`;
}

export function parseBalanceText(text) {
  return Number(String(text).replace(/[^0-9.-]/g, '')) || 0;
}

// The routing number belongs to the bank. The account number is the account's
// own: a permanent one is issued server-side once identity is verified and the
// account has been active thirty days, and until then the account carries a
// temporary eleven-digit number so there is something to quote.
//
// Neither is rolled at random on the device any more. The name is kept because
// callers across six screens use it.
export function getOrCreateTempNumber(type, kind) {
  if (kind === 'routing') {
    return NO_ROUTING_ACCOUNT_TYPES.includes(type) ? '' : bankRoutingNumber;
  }
  // A permanent, server-issued number always wins. Until one is issued the
  // account still needs something to show, so it carries a temporary one.
  return accountNumbersByType[type] || temporaryAccountNumber(type);
}

// A temporary account number has to be the same number wherever you sign in.
// The old one was eleven random digits cached in localStorage, so the same
// account read differently on a phone and a laptop. This derives the digits
// from the account holder's id and the account type instead: same user, same
// account, same number, on every device and with nothing stored. Each account
// type seeds differently, so investments never shares checking's number.
function temporaryAccountNumber(type) {
  if (!currentUserId) return '';
  const seed = `${currentUserId}:${type}`;

  // Two independent FNV-1a passes, so the eleven digits are drawn from more
  // entropy than a single 32-bit hash would give.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    const code = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
  }

  // Stays inside Number's safe range: 99999 * 1e6 + 999999 is well under 2^53.
  const digits = (h1 % 100000) * 1000000 + (h2 % 1000000);
  return String(digits).padStart(11, '0');
}

// ---------- Bank reference data ----------
// Read once per session and shared by every screen that prints these, rather
// than each screen asking for itself.

// The routing number identifies the bank, not the customer, so it is the same
// on every account it applies to and does not vary between users — only the
// account number does. It is a constant here so a screen is never blank waiting
// on the network, and bank_settings still overrides it if the bank ever moves.
const DEFAULT_ROUTING_NUMBER = '856919671';

// A brokerage account is not a deposit account: it has no ABA routing number to
// show, so asking for one returns nothing rather than the bank's.
const NO_ROUTING_ACCOUNT_TYPES = ['investments'];

let bankRoutingNumber = DEFAULT_ROUTING_NUMBER;
let accountNumbersByType = {};
// Seeds the temporary account numbers above, so they are stable per person.
let currentUserId = '';

// Whether the user holds a card at all. Card Services is left out of the menu
// entirely when they do not, rather than shown and then apologised for.
let hasOpenCreditCard = false;

async function loadBankReference() {
  if (!supabaseClient) return;

  try {
    const { data: settings, error } = await supabaseClient
      .from('bank_settings')
      .select('routing_number')
      .eq('id', 1)
      .maybeSingle();
    if (error) throw error;
    if (settings && settings.routing_number) bankRoutingNumber = String(settings.routing_number);
  } catch (err) {
    console.error('Bank settings error:', err);
  }

  try {
    const user = await getCurrentUser();
    if (!user) return;
    currentUserId = user.id;
    const { data: rows, error } = await supabaseClient
      .from('accounts')
      .select('*')
      .eq('user_id', user.id);
    if (error) throw error;

    (rows || []).forEach((row) => {
      if (row && row.account_type && row.account_number) {
        accountNumbersByType[row.account_type] = String(row.account_number);
      }
    });

    hasOpenCreditCard = (rows || []).some((row) => row && row.product_type === 'credit_card' && row.status === 'open');
    renderAccountNumberMasks();
  } catch (err) {
    console.error('Account reference error:', err);
  }
}

// The masked numbers on the account cards were literals in the markup, so every
// account read •4892 or •9104 no matter what its real number was. They show the
// account's own number now — permanent if one has been issued, temporary until
// then — and each account type carries its own, so investments never borrows
// the checking account's last four.
function renderAccountNumberMasks() {
  const masks = { checkingNumber: 'checking', savingsNumber: 'savings', investmentsNumber: 'investments' };
  Object.keys(masks).forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const number = getOrCreateTempNumber(masks[id], 'account');
    el.textContent = number ? `•${String(number).slice(-4)}` : '';
  });
}

// ---------- Theme ----------
// Light is the default and stays the default. The app never consults the
// device's colour scheme to decide for itself — a bank that opens dark because
// the television happens to be dark is a surprise, not a preference. It opens
// light, and only an explicit choice moves it, which is then remembered.
const htmlElement = document.documentElement;
const THEME_KEY = 'vercel_bank_theme';

export function applyTheme(isDark) {
  htmlElement.classList.toggle('dark', isDark);
  document.body.classList.toggle('dark', isDark);
  // Wrapped, because a browser with storage blocked — a TV, a kiosk, private
  // browsing — throws here. Unguarded, that throw happened at module load and
  // took the entire app down with it rather than just the one setting.
  try { localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light'); } catch (err) {}
}

function storedTheme() {
  try { return localStorage.getItem(THEME_KEY) || ''; } catch (err) { return ''; }
}

// Only a stored 'dark' turns it dark. Anything else — no preference at all, an
// unreadable store, a value from some older build — lands on light.
applyTheme(storedTheme() === 'dark');

// ---------- Shared modal (every page module can call this) ----------
const actionModal = document.getElementById('actionModal');
const modalTitle = document.getElementById('modalTitle');
const modalDesc = document.getElementById('modalDesc');
const modalCloseBtn = document.getElementById('modalCloseBtn');

export function showModal(title, desc) {
  modalTitle.textContent = title;
  modalDesc.textContent = desc;
  actionModal.classList.remove('hidden');
}
modalCloseBtn.addEventListener('click', () => actionModal.classList.add('hidden'));

// ---------- Lazy page loader ----------
// pageRoot is a single empty <div> in index.html. Every screen's markup gets
// injected there only while it's open, then cleared again on close — so the
// DOM never carries the weight of 30 screens at once.
const pageRoot = document.getElementById('page-root');
let activePageCleanup = null;

/**
 * Open a page by name. Expects:
 *   /pages/<name>.html   — the fragment markup
 *   /js/pages/<name>.js  — a module exporting `init(root)` and optionally `cleanup()`
 */
export async function loadPage(name, ...args) {
  // The Profile menu is the original dark dropdown/modal (navMenuSheet), not
  // a page — redirect any `loadPage('profile')` call (e.g. a destination
  // page's "Return to Profile"/back button) there instead.
  if (name === 'profile') {
    if (activePageCleanup) { activePageCleanup(); activePageCleanup = null; }
    return openNavMenu('navProfile');
  }

  // Tear down whatever page is currently open first
  if (activePageCleanup) { activePageCleanup(); activePageCleanup = null; }

  const [html, mod] = await Promise.all([
    fetch(`/pages/${name}.html`).then(r => r.text()),
    import(`/js/pages/${name}.js`)
  ]);

  pageRoot.innerHTML = html;
  pageRoot.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Each page module gets shared helpers passed in, rather than importing
  // globals off `window` — keeps every page module self-contained and testable.
  const closePage = () => {
    if (mod.cleanup) mod.cleanup();
    pageRoot.classList.add('hidden');
    pageRoot.innerHTML = '';
    document.body.style.overflow = '';
  };

  mod.init(pageRoot, {
    close: closePage,
    loadPage,
    supabaseClient,
    getCurrentUser,
    genRef,
    formatCurrency,
    parseBalanceText,
    getOrCreateTempNumber,
    showModal,
    openSupportMessage,
    refreshAlertsBadge,
    getCardEligibility,
    signOut: () => handleSignOut(),
  }, ...args);

  activePageCleanup = closePage;
}

// Close any open screen and return to the dashboard, which is also the
// account summary.
export function showHome() {
  if (activePageCleanup) { activePageCleanup(); activePageCleanup = null; }
  window.scrollTo(0, 0);
}

// Opens the Support tab straight on its New message form with the category,
// subject and body already filled in. Any screen can hand a user to support
// without knowing how Support is put together: it is passed to every page
// module in its context object, and sits on `window` for markup-level handlers.
export function openSupportMessage({ category, subject, body } = {}) {
  return loadPage('support', { view: 'new', category, subject, body });
}

// Expose for inline onclick handlers if any page markup still uses them
window.loadPage = loadPage;
window.showModal = showModal;
window.openSupportMessage = openSupportMessage;

// ==================== DASHBOARD SHELL ====================
// Everything below wires up the always-present shell: header dropdown menus,
// account cards, the bottom nav bar and its slide-up menu sheet. Screens that
// haven't been ported yet (see README "Screens still to port") fall back to
// the shared modal instead of silently doing nothing.

const greetingLine1 = document.getElementById('greetingLine1');
const greetingLine2 = document.getElementById('greetingLine2');

// ---------- Header dropdown (More / Appearance / Messages / Profile) ----------
const headerMenus = {
  more: {
    title: 'Quick Actions',
    items: ['Nickname accounts', 'Reorder accounts', 'Hide an account', 'Download all statements', 'Card Services', 'Settings'],
  },
  appearance: { title: 'Appearance', items: ['Light Mode', 'Dark Mode'] },
  messages: { title: 'Messages', items: ['Contact Support', 'Schedule an Appointment'] },
  profile: { title: 'Profile', items: ['My Profile', 'Linked Accounts', 'Notification Preferences', 'Privacy & Data Settings', 'Sign Out'] },
};

const headerDropdownOverlay = document.getElementById('headerDropdownOverlay');
const headerDropdown = document.getElementById('headerDropdown');
const headerDropdownTitle = document.getElementById('headerDropdownTitle');
const headerDropdownList = document.getElementById('headerDropdownList');

// Supabase persists the session under `sb-<project-ref>-auth-token`, which is
// not a `verceil_` key — so clearing only our own keys left the session token
// behind, and the auth guard waved the user straight back in after a sign-out
// whose server call had failed.
function clearCachedUserData() {
  try {
    Object.keys(localStorage)
      .filter((key) => key.startsWith('verceil_') || (key.startsWith('sb-') && key.includes('auth-token')))
      .forEach((key) => localStorage.removeItem(key));
  } catch (err) {}
  try { sessionStorage.clear(); } catch (err) {}
}

function goToSignIn() {
  // The standalone sign-in page, which is the current one. This used to go to
  // index.html?signin=1, the landing page's older Sign In modal.
  window.location.href = 'signin.html';
}

async function handleSignOut() {
  try {
    if (!supabaseClient) throw new Error('Supabase client is unavailable — signing out locally only.');

    // supabase-js v2 returns { error } rather than throwing, so the old
    // unchecked `await` reported success even when the session was never
    // revoked. Read it.
    const { error } = await supabaseClient.auth.signOut();
    if (error) {
      // The default global revoke needs a still-valid refresh token; once
      // that has expired it fails and the user would be stuck signed in.
      // Dropping this device's session is the fallback that always works.
      console.error('Supabase global sign out failed, falling back to local:', error);
      const { error: localError } = await supabaseClient.auth.signOut({ scope: 'local' });
      if (localError) throw localError;
    }
  } catch (err) {
    console.error('Sign out error:', err);
  } finally {
    // Runs whether or not the revoke succeeded: the token is gone from this
    // browser either way, so the user is never left half signed-in.
    clearCachedUserData();
    goToSignIn();
  }
}

// Route protection: the dashboard shell requires an active Supabase session.
// If none exists (first load, expired session, or a sign-out that just
// happened in another tab) send the user straight back to the landing page
// with the Sign In modal ready to open.
async function enforceAuthGuard() {
  if (!supabaseClient) return;
  try {
    const user = await getCurrentUser();
    if (!user) goToSignIn();
  } catch (err) {
    console.error('Auth guard error:', err);
  }
}
enforceAuthGuard();

// Cross-tab / cross-device sync: supabase-js mirrors auth state changes made
// in any tab (or device, via the shared session) into every other tab's
// client through onAuthStateChange. When a sign-out happens anywhere, every
// open dashboard tab reacts immediately instead of trusting stale state.
if (supabaseClient) {
  supabaseClient.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      clearCachedUserData();
      goToSignIn();
    }
  });
}

// ---------- Alerts badge ----------
// The badge counts unread notifications and nothing else, so it is the same
// number the Notifications view is showing and the two can never disagree. It
// stays hidden entirely at zero rather than rendering a badge reading "0".
const alertsBadge = document.getElementById('alertsBadge');

function setAlertsCount(count) {
  if (!alertsBadge) return;
  alertsBadge.textContent = String(count);
  alertsBadge.classList.toggle('hidden', count <= 0);
  alertsBadge.classList.toggle('flex', count > 0);
}

// Counted on the server rather than by fetching the rows: the badge only ever
// needs the number, and the Notifications view is what fetches the notifications.
// Exported so that view can re-run it after a row is read, after Mark all read,
// and when a new notification arrives over Realtime.
export async function refreshAlertsBadge() {
  setAlertsCount(0);
  if (!supabaseClient) return;
  try {
    const user = await getCurrentUser();
    if (!user) return;

    const { count, error } = await supabaseClient
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('is_read', false);
    if (error) throw error;

    setAlertsCount(count || 0);
  } catch (err) {
    console.error('Alerts badge error:', err);
  }
}

function openHeaderDropdown(key, anchorEl) {
  const menu = headerMenus[key];
  if (!menu) return;

  const isLight = !htmlElement.classList.contains('dark');

  headerDropdown.style.background = isLight ? '#FFFFFF' : '#0D1728';
  headerDropdown.style.border = isLight ? '1px solid transparent' : '1px solid rgba(255,255,255,0.06)';
  headerDropdownTitle.style.color = isLight ? '#111827' : '#FFFFFF';
  headerDropdownTitle.textContent = menu.title;

  const rowBorder = isLight ? '#F3F4F6' : 'rgba(255,255,255,0.06)';
  const textColor = isLight ? '#111827' : '#FFFFFF';
  const chevronColor = isLight ? '#6B7280' : '#8E9CBA';

  // Card Services is only a destination for someone who holds a card. With no
  // card the row is left out rather than rendered disabled.
  const items = key === 'more' && !hasOpenCreditCard
    ? menu.items.filter((item) => item !== 'Card Services')
    : menu.items;

  headerDropdownList.innerHTML = items.map((item, idx) => {
    const label = typeof item === 'string' ? item : item.label;
    const sublabel = typeof item === 'string' ? '' : (item.sublabel || '');
    const inert = typeof item !== 'string' && item.inert;
    const isLast = idx === items.length - 1;
    return `
      <button class="header-dropdown-item w-full flex items-center gap-[12px] px-[16px] py-[10px] transition-colors duration-200 ${inert ? 'cursor-default' : 'cursor-pointer'} text-left"
        style="min-height:52px; ${isLast ? '' : `border-bottom:1px solid ${rowBorder};`} color:${textColor};"
        data-label="${label}" ${inert ? 'data-inert="1"' : ''}>
        <span class="flex-1 min-w-0">
          <span class="block text-[15px] font-medium truncate">${label}</span>
          ${sublabel ? `<span class="block text-[12px] font-normal truncate" style="color:${chevronColor};">${sublabel}</span>` : ''}
        </span>
        ${inert ? '' : `<svg class="w-[16px] h-[16px] flex-shrink-0" style="color:${chevronColor};" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>`}
      </button>
    `;
  }).join('');

  const rect = anchorEl.getBoundingClientRect();
  const dropdownWidth = 260;
  let leftPos = Math.min(rect.left, window.innerWidth - dropdownWidth - 16);
  leftPos = Math.max(leftPos, 16);
  headerDropdown.style.top = (rect.bottom + 10) + 'px';
  headerDropdown.style.left = leftPos + 'px';
  headerDropdown.style.right = 'auto';

  headerDropdownOverlay.classList.remove('hidden');
  headerDropdown.classList.remove('hidden');

  headerDropdownList.querySelectorAll('.header-dropdown-item').forEach(btn => {
    btn.addEventListener('mouseenter', () => { btn.style.color = '#2563EB'; });
    btn.addEventListener('mouseleave', () => { btn.style.color = textColor; });
    btn.addEventListener('click', () => {
      const clickedLabel = btn.getAttribute('data-label');
      closeHeaderDropdown();
      // A notification row is a record, not a destination.
      if (btn.getAttribute('data-inert')) return;
      if (key === 'appearance') {
        applyTheme(clickedLabel === 'Dark Mode');
      } else if (clickedLabel === 'Sign Out') {
        handleSignOut();
      } else if (headerMenuRoutes[clickedLabel]) {
        setTimeout(() => headerMenuRoutes[clickedLabel](), 200);
      } else {
        setTimeout(() => showModal(clickedLabel, `Opening ${clickedLabel}...`), 200);
      }
    });
  });
}

function closeHeaderDropdown() {
  headerDropdownOverlay.classList.add('hidden');
  headerDropdown.classList.add('hidden');
}

headerDropdownOverlay.addEventListener('click', closeHeaderDropdown);
document.getElementById('moreMenuBtn').addEventListener('click', (e) => openHeaderDropdown('more', e.currentTarget));
document.getElementById('appearanceBtn').addEventListener('click', (e) => openHeaderDropdown('appearance', e.currentTarget));
// The bell is a doorway to the Notifications screen now, not a dropdown: a
// notification has to be readable in full, and a 260px box anchored under an
// icon could not do that.
document.getElementById('alertsBtn').addEventListener('click', () => loadPage('notifications'));
document.getElementById('messagesBtn').addEventListener('click', (e) => openHeaderDropdown('messages', e.currentTarget));
document.getElementById('profilePillBtn').addEventListener('click', (e) => openHeaderDropdown('profile', e.currentTarget));

// ---------- Account cards ----------
document.getElementById('cardChecking').addEventListener('click', () => loadPage('account-detail', 'checking'));
document.getElementById('cardSavings').addEventListener('click', () => loadPage('account-detail', 'savings'));
document.getElementById('cardInvestments').addEventListener('click', () => loadPage('account-detail', 'investments'));
document.getElementById('cardCredit').addEventListener('click', () => loadPage('account-detail', 'credit'));
document.getElementById('cardInterestChecking').addEventListener('click', () => loadPage('account-detail', 'interest_checking'));
document.getElementById('promoBanner').addEventListener('click', () => loadPage('interest-checking'));
// ---------- Signature Card eligibility ----------
const CARD_ELIGIBILITY_MONTHS = 8;

// Whole months only, so someone who joined on the 30th is not credited with a
// month on the 1st.
function wholeMonthsSince(from, to) {
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) months -= 1;
  return Math.max(0, months);
}

function eligibilityMonthLabel(from) {
  const reached = new Date(from.getFullYear(), from.getMonth() + CARD_ELIGIBILITY_MONTHS, from.getDate());
  return reached.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// Everything the credit account screen needs to state its own terms: how long
// the account has been open, whether that clears the threshold, and the month
// it does. Computed here so membership length has one definition, and handed to
// page modules through their context object.
export async function getCardEligibility() {
  let joined = null;
  try {
    const user = await getCurrentUser();
    if (user) {
      // The profile row carries the membership date; the auth user's own
      // created_at is the fallback, since that one always exists.
      let profileCreated = null;
      if (supabaseClient) {
        const { data } = await supabaseClient
          .from('user_profile')
          .select('created_at')
          .eq('user_id', user.id)
          .maybeSingle();
        if (data && data.created_at) profileCreated = data.created_at;
      }
      const candidate = new Date(profileCreated || user.created_at);
      if (!isNaN(candidate)) joined = candidate;
    }
  } catch (err) {
    console.error('Card eligibility error:', err);
  }

  const months = joined ? wholeMonthsSince(joined, new Date()) : 0;
  return {
    // An unknown join date reads as not yet eligible. Guessing in the user's
    // favour would promise an application the bank cannot honour.
    eligible: !!joined && months >= CARD_ELIGIBILITY_MONTHS,
    months,
    thresholdMonths: CARD_ELIGIBILITY_MONTHS,
    eligibleFrom: joined ? eligibilityMonthLabel(joined) : '',
  };
}

document.getElementById('offerCredit').addEventListener('click', () => loadPage('account-detail', 'credit'));

// ---------- Quick actions (from the old account summary) ----------
document.getElementById('homeQuickTransfer').addEventListener('click', () => loadPage('transfer'));
document.getElementById('homeQuickSendMoney').addEventListener('click', () => loadPage('send-money'));
document.getElementById('homeQuickDeposit').addEventListener('click', () => loadPage('fund-account'));
document.getElementById('homeQuickStatements').addEventListener('click', () => loadPage('docs-hub'));

// ---------- Bottom nav dropdown menu sheet (Citi-style) ----------
const navMenus = {
  navAccounts: {
    title: 'Accounts',
    items: ['Account Summary', 'Checking', 'Savings', 'Interest Checking', 'Credit Cards', 'Investment Accounts', 'Statements & Documents', 'Account Details', 'Routing & Account Numbers'],
  },
  navPayments: {
    title: 'Payments',
    items: ['Fund Account', 'Transfer Between Accounts', 'Send Money (Zelle®)', 'Scheduled Payments', 'External Transfers', 'Wire Transfers'],
  },
  navInvest: {
    title: 'Invest',
    items: ['Portfolio Overview', 'Market Performance', 'Watchlist', 'Buy & Sell Investments', 'Retirement Accounts', 'Wealth Insights', 'Investment Statements', 'Financial Advisor'],
  },
  navSupport: {
    title: 'Support',
    items: ['Contact Support', 'Card Services', 'Report Lost or Stolen Card', 'Help Center'],
  },
  navProfile: {
    title: 'Profile',
    groups: [
      { category: 'Personal Information', items: ['Full Legal Name', 'Date of Birth', 'Residential Address', 'Mailing Address', 'Phone Number', 'Email Address'], note: 'Name and date of birth are locked after verification. Contact support to change them.' },
      { category: 'Additional', items: ['Linked Accounts', 'Tax Documents', 'Notification Preferences', 'Privacy & Data Settings'] },
    ],
    standaloneItems: ['Sign Out'],
  },
};

const navMenuOverlay = document.getElementById('navMenuOverlay');
const navMenuSheet = document.getElementById('navMenuSheet');
const navMenuTitle = document.getElementById('navMenuTitle');
const navMenuList = document.getElementById('navMenuList');
const navMenuCloseBtn = document.getElementById('navMenuCloseBtn');

// Labels that map to a screen already ported to the split architecture.
const navMenuRoutes = {
  // Accounts
  // The account summary is the dashboard now, so this closes whatever screen
  // is open and returns to it rather than loading a page of its own.
  'Account Summary': () => showHome(),
  'Checking': () => loadPage('account-detail', 'checking'),
  'Savings': () => loadPage('account-detail', 'savings'),
  'Interest Checking': () => loadPage('account-detail', 'interest_checking'),
  'Credit Cards': () => loadPage('account-detail', 'credit'),
  'Investment Accounts': () => loadPage('account-detail', 'investments'),
  'Statements & Documents': () => loadPage('docs-hub'),
  'Account Details': () => loadPage('account-details'),
  'Routing & Account Numbers': () => loadPage('routing-numbers'),

  // Payments
  'Transfer Between Accounts': () => loadPage('transfer'),
  'Fund Account': () => loadPage('fund-account'),
  'Send Money (Zelle®)': () => loadPage('send-money'),
  'Scheduled Payments': () => loadPage('scheduled-payments'),
  'External Transfers': () => loadPage('external-transfers'),
  'Wire Transfers': () => loadPage('wire-transfers'),

  // Invest
  'Portfolio Overview': () => loadPage('portfolio'),
  'Watchlist': () => loadPage('watchlist'),
  'Buy & Sell Investments': () => loadPage('trade'),
  'Wealth Insights': () => loadPage('wealth-insights'),
  'Investment Statements': () => loadPage('statements'),
  'Financial Advisor': () => loadPage('advisor'),

  // Support
  'Contact Support': () => loadPage('contact-support'),
  'Card Services': () => loadPage('card-services'),
  'Report Lost or Stolen Card': () => loadPage('report-card'),
  'Help Center': () => loadPage('help-center'),

  // Profile — Personal Information
  'Full Legal Name': () => loadPage('profile-full-name'),
  'Date of Birth': () => loadPage('profile-dob'),
  'Residential Address': () => loadPage('profile-residential-address'),
  'Mailing Address': () => loadPage('profile-mailing-address'),
  'Phone Number': () => loadPage('profile-phone'),
  'Email Address': () => loadPage('profile-email'),

  // Profile — Additional
  'Linked Accounts': () => loadPage('linked-accounts'),
  // Statements and tax forms are two tabs of the one documents screen, so this
  // opens that screen on its tax tab rather than a second page of its own.
  'Tax Documents': () => loadPage('docs-hub', 'tax'),
  'Notification Preferences': () => loadPage('notification-prefs'),
  'Privacy & Data Settings': () => loadPage('privacy'),
};

// Labels in the header "quick actions" dropdown that map to a ported screen.
const headerMenuRoutes = {
  // Quick actions. Only Card Services and Download all statements have a screen
  // behind them; the rest open the shared placeholder rather than doing nothing.
  'Nickname accounts': () => loadPage('coming-soon', 'Nickname accounts'),
  'Reorder accounts': () => loadPage('coming-soon', 'Reorder accounts'),
  'Hide an account': () => loadPage('coming-soon', 'Hide an account'),
  'Download all statements': () => loadPage('docs-hub'),
  'Card Services': () => loadPage('card-services'),
  'Settings': () => loadPage('coming-soon', 'Settings'),
  'Contact Support': () => loadPage('contact-support'),
  'My Profile': () => loadPage('profile'),
  'Linked Accounts': () => loadPage('linked-accounts'),
  'Notification Preferences': () => loadPage('notification-prefs'),
  'Privacy & Data Settings': () => loadPage('privacy'),
};

// ---------- Profile sheet row values ----------
// The personal information rows show what is currently on file beside their
// label, read from the same `user_profile` row the individual profile screens
// write to — so the sheet answers "what is my address?" without a tap.
const PROFILE_VALUE_ROWS = ['Full Legal Name', 'Date of Birth', 'Residential Address', 'Mailing Address', 'Phone Number', 'Email Address'];

// Locked once identity has been verified. These two are facts on the record
// rather than something to edit, so they lose their chevron and their tap.
const LOCKED_PROFILE_ROWS = ['Full Legal Name', 'Date of Birth'];

let profileRowValues = {};

// Enough of the date to recognise it as yours, not enough to be worth reading
// over your shoulder — the year is the part people check.
function maskDateOfBirth(value) {
  const year = String(value || '').slice(0, 4);
  return /^\d{4}$/.test(year) ? `••/••/${year}` : '';
}

function maskPhoneNumber(digitsSource) {
  const digits = String(digitsSource || '').replace(/\D/g, '');
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : '';
}

// Enough to recognise the address as yours without printing where you live.
function cityAndCountry(city, country) {
  return [String(city || '').trim(), String(country || '').trim()].filter(Boolean).join(', ');
}

// Name and date of birth live in three places and are written by three
// different flows, so the sheet reads all three rather than the one that
// happens to be empty. `user_profile` first because it is the one the profile
// screens edit, then the verification record's legal name, then what was typed
// at sign-up. Whichever is on file is what the row shows.
function buildProfileRowValues(profile, user, verification) {
  // `mail_same_as_res` is only false once someone has explicitly said the two
  // differ, which is the same default the Mailing Address screen applies.
  const mailingDiffers = profile.mail_same_as_res === false;
  const meta = (user && user.user_metadata) || {};
  const ver = verification || {};

  // Sign-up stores these under whichever keys the form used, so every shape it
  // could have taken is tried rather than one guess.
  const joinName = (source, keys) => keys.map((k) => source[k]).filter(Boolean).join(' ');

  const nameFromProfile = joinName(profile, ['first_name', 'middle_name', 'last_name', 'suffix']) || profile.full_name || '';
  const nameFromVerification = joinName(ver, ['legal_first_name', 'legal_middle_name', 'legal_last_name']);
  const nameFromSignUp = joinName(meta, ['first_name', 'middle_name', 'last_name', 'suffix'])
    || meta.full_name || meta.name || '';

  const dob = profile.date_of_birth || ver.date_of_birth || meta.date_of_birth || meta.dob || '';

  return {
    'Full Legal Name': nameFromProfile || nameFromVerification || nameFromSignUp,
    'Date of Birth': maskDateOfBirth(dob),
    'Residential Address': cityAndCountry(profile.res_city || ver.city, profile.res_country || ver.state),
    // Nothing when the mailing address simply matches the residential one —
    // saying so on the list is noise, and the detail screen says it anyway.
    'Mailing Address': mailingDiffers ? cityAndCountry(profile.mail_city, profile.mail_state) : '',
    'Phone Number': maskPhoneNumber(profile.phone_number),
    // Not shown on the list at all. The address is on its own screen, which is
    // where you go to read it.
    'Email Address': '',
  };
}

function applyProfileRowValues() {
  navMenuList.querySelectorAll('[data-profile-value]').forEach(el => {
    el.textContent = profileRowValues[el.getAttribute('data-profile-value')] || '';
  });
}

// Fetched each time the sheet opens so an edit made on a profile screen is
// reflected the moment you come back to it. The rows render from the last
// known values first, so the sheet never waits on the network to draw.
async function refreshProfileRowValues() {
  if (!supabaseClient) return;
  try {
    const user = await getCurrentUser();
    if (!user) return;
    // Both reads in parallel: the sheet needs whichever of them has the name.
    const [{ data: profile }, { data: verification }] = await Promise.all([
      supabaseClient.from('user_profile').select('*').eq('user_id', user.id).maybeSingle(),
      supabaseClient.from('verification_requests').select('*').eq('user_id', user.id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ]);
    profileRowValues = buildProfileRowValues(profile || {}, user, verification || {});
    applyProfileRowValues();
  } catch (err) {
    console.error('Profile row values error:', err);
  }
}

// One row rendered two ways: the standard tappable row with its chevron, or —
// for a locked field — the same row without either, so nothing on it reads as
// a link. Only the personal information rows carry a value.
function renderNavMenuGroupRow(item) {
  const label = `<span class="text-[15px] font-medium text-[#111827] dark:text-[#FFFFFF]">${item}</span>`;
  const value = PROFILE_VALUE_ROWS.includes(item)
    ? `<span class="text-[13px] text-[#6B7280] dark:text-[#8E9CBA] text-right truncate min-w-0 ml-[12px]" data-profile-value="${item}">${profileRowValues[item] || ''}</span>`
    : '';

  if (LOCKED_PROFILE_ROWS.includes(item)) {
    return `
        <div class="w-full flex items-center justify-between px-[12px] py-[14px] rounded-[14px] text-left">
          ${label}
          ${value}
        </div>
      `;
  }

  return `
        <button class="nav-menu-item w-full flex items-center justify-between px-[12px] py-[14px] rounded-[14px] hover:bg-gray-50 dark:hover:bg-white/5 transition-all cursor-pointer text-left">
          ${label}
          ${value}
          <svg class="w-[16px] h-[16px] text-gray-400 dark:text-[#52607D] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </button>
      `;
}

function openNavMenu(key) {
  const menu = navMenus[key];
  if (!menu) return;

  navMenuTitle.textContent = menu.title;

  if (menu.groups) {
    navMenuList.innerHTML = menu.groups.map(group => `
      <div class="px-[12px] pt-[16px] pb-[4px] text-[12px] font-bold uppercase tracking-[0.8px] text-[#6B7280] dark:text-[#8E9CBA]">${group.category}</div>
      ${group.items.map(item => renderNavMenuGroupRow(item)).join('')}
      ${group.note ? `<div class="px-[12px] pt-[6px] pb-[2px] text-[12px] leading-relaxed text-[#6B7280] dark:text-[#8E9CBA]">${group.note}</div>` : ''}
    `).join('') + (menu.standaloneItems ? `
      <div class="border-t border-gray-100 dark:border-white/[0.06] mt-[8px] pt-[8px]">
        ${menu.standaloneItems.map(item => `
          <button class="nav-menu-item w-full flex items-center justify-between px-[12px] py-[14px] rounded-[14px] hover:bg-red-50 dark:hover:bg-white/5 transition-all cursor-pointer text-left">
            <span class="text-[15px] font-semibold text-[#DC2626]">${item}</span>
          </button>
        `).join('')}
      </div>
    ` : '');
  } else {
    // Card Services is only a destination for someone who holds a card. With
    // no card the row is left out rather than rendered disabled or opening a
    // page whose only job is to say you have nothing here.
    const items = key === 'navSupport' && !hasOpenCreditCard
      ? menu.items.filter((item) => item !== 'Card Services')
      : menu.items;
    navMenuList.innerHTML = items.map(item => `
      <button class="nav-menu-item w-full flex items-center justify-between px-[12px] py-[14px] rounded-[14px] hover:bg-gray-50 dark:hover:bg-white/5 transition-all cursor-pointer text-left">
        <span class="text-[15px] font-medium text-[#111827] dark:text-[#FFFFFF]">${item}</span>
        <svg class="w-[16px] h-[16px] text-gray-400 dark:text-[#52607D] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
      </button>
    `).join('');
  }

  navMenuList.querySelectorAll('.nav-menu-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const label = btn.querySelector('span').textContent;
      closeNavMenu();
      if (label === 'Sign Out') {
        handleSignOut();
      } else if (navMenuRoutes[label]) {
        setTimeout(() => navMenuRoutes[label](), 260);
      } else {
        setTimeout(() => showModal(label, `Opening ${label}...`), 260);
      }
    });
  });

  if (key === 'navProfile') refreshProfileRowValues();

  navMenuOverlay.classList.remove('hidden');
  navMenuSheet.classList.remove('hidden');
  // Every menu shares this one scroll container, so it opens wherever the last
  // menu was left scrolled to — which hid the first group's section label
  // behind the header. Reset it before the sheet slides up, and again once it
  // has been laid out, since the browser can restore the old offset in between.
  navMenuList.scrollTop = 0;
  requestAnimationFrame(() => {
    navMenuSheet.classList.remove('translate-y-full');
    navMenuList.scrollTop = 0;
  });
  document.body.style.overflow = 'hidden';
}

function closeNavMenu() {
  navMenuSheet.classList.add('translate-y-full');
  document.body.style.overflow = '';
  setTimeout(() => {
    navMenuOverlay.classList.add('hidden');
    navMenuSheet.classList.add('hidden');
  }, 300);
}

navMenuCloseBtn.addEventListener('click', closeNavMenu);
navMenuOverlay.addEventListener('click', closeNavMenu);
document.getElementById('navAccounts').addEventListener('click', () => openNavMenu('navAccounts'));
document.getElementById('navPayments').addEventListener('click', () => openNavMenu('navPayments'));
document.getElementById('navInvest').addEventListener('click', () => openNavMenu('navInvest'));
document.getElementById('navSupport').addEventListener('click', () => openNavMenu('navSupport'));
document.getElementById('navProfile').addEventListener('click', () => openNavMenu('navProfile'));

// ---------- Greeting + live balances from Supabase ----------
async function initSupabaseData() {
  const hours = new Date().getHours();
  let timeOfDay = 'Good Afternoon';
  if (hours < 12) timeOfDay = 'Good Morning';
  else if (hours >= 17) timeOfDay = 'Good Evening';

  let userName = 'Mercy';

  // Every account we know about, keyed by its row id. Totals are derived from
  // this map rather than accumulated as rows arrive, so re-applying the same
  // account updates it in place and two accounts of the same type add together
  // instead of the second overwriting the first.
  const accountsById = new Map();

  // Money is summed in cents. Adding dollars as floats drifts — .10 + .20
  // lands on 0.30000000000000004 — and a balance that is a cent out is worse
  // than no balance at all.
  function toCents(value) {
    return Math.round((Number(value) || 0) * 100);
  }

  const DEPOSIT_TYPES = ['checking', 'savings', 'interest_checking'];

  // A card counts as real once it is approved or has any activity against it.
  function isActiveCard(acc) {
    return acc.account_type === 'credit'
      && (acc.status === 'approved' || Number(acc.balance) > 0 || Number(acc.available_credit) > 0);
  }

  // This table has no 'open' status: rows are written with status 'approved'
  // and deposit rows carry no status at all, so testing for 'open' would
  // exclude every account. A row counts unless it says it is shut.
  const CLOSED_STATUSES = ['closed', 'cancelled', 'canceled', 'suspended', 'frozen'];

  function isOpenAccount(acc) {
    return !CLOSED_STATUSES.includes(String(acc.status || '').toLowerCase());
  }

  // Closed accounts are excluded here rather than in each caller, so no total
  // can pick up a shut account by forgetting to ask.
  function sumCents(matches) {
    let cents = 0;
    accountsById.forEach(acc => {
      if (isOpenAccount(acc) && matches(acc)) cents += toCents(acc.balance);
    });
    return cents;
  }

  function setText(id, cents) {
    const el = document.getElementById(id);
    if (el) el.textContent = formatCurrency(cents / 100);
  }

  function firstMatch(matches) {
    let found = null;
    accountsById.forEach(acc => {
      if (!found && isOpenAccount(acc) && matches(acc)) found = acc;
    });
    return found;
  }

  function renderTotals() {
    const deposits = sumCents(acc => DEPOSIT_TYPES.includes(acc.account_type));
    const investments = sumCents(acc => acc.account_type === 'investments');
    const cardDebt = sumCents(isActiveCard);

    // Each card shows the total across every account of its type, so the
    // hero's Deposits is exactly the three cards beneath it added up.
    setText('checkingBalance', sumCents(acc => acc.account_type === 'checking'));
    setText('savingsBalance', sumCents(acc => acc.account_type === 'savings'));
    setText('interestCheckingBalance', sumCents(acc => acc.account_type === 'interest_checking'));
    setText('investmentsBalance', investments);
    setText('creditBalance', cardDebt);

    setText('homeDeposits', deposits);
    setText('homeInvestments', investments);
    setText('homeCardBalance', cardDebt);
    // Total balance is deposit money only, the way a bank states it. Investment
    // value is a market figure that moves on its own and is reported beside the
    // total, not inside it; a card balance is money owed to the issuer, so it
    // is shown as its own line rather than netted off cash on hand.
    setText('homeTotalBalance', deposits);

    const hasInterestChecking = !!firstMatch(acc => acc.account_type === 'interest_checking');
    const card = firstMatch(isActiveCard);
    toggleSection('sectionInterestChecking', 'promoBanner', hasInterestChecking);
    toggleSection('sectionCredit', 'offerCredit', !!card);

    if (card) {
      const sublabel = document.getElementById('creditSublabel');
      if (sublabel && card.available_credit !== undefined && card.available_credit !== null) {
        sublabel.textContent = `${formatCurrency(card.available_credit)} available`;
      }
      const numberEl = document.getElementById('creditNumber');
      if (numberEl && card.account_number) {
        numberEl.textContent = `•${String(card.account_number).slice(-4)}`;
      }
    }

    refreshOffersLabel();
  }

  // Once an account is open it is an account, not an offer.
  function toggleSection(sectionId, offerId, isOpen) {
    const section = document.getElementById(sectionId);
    const offer = document.getElementById(offerId);
    if (section) section.classList.toggle('hidden', !isOpen);
    if (offer) offer.classList.toggle('hidden', isOpen);
  }

  // Rows without an id (the offline fallback below) are keyed by type, which
  // is the best identity available and still cannot double-count itself.
  function applyAccountRow(acc) {
    if (!acc || !acc.account_type) return;
    accountsById.set(acc.id != null ? `id:${acc.id}` : `type:${acc.account_type}`, acc);
    renderTotals();
  }

  function removeAccountRow(acc) {
    if (!acc) return;
    accountsById.delete(acc.id != null ? `id:${acc.id}` : `type:${acc.account_type}`);
    renderTotals();
  }

  // "Available to You" only makes sense while something is still on offer.
  function refreshOffersLabel() {
    const label = document.getElementById('homeOffersLabel');
    const offers = document.getElementById('homeOffers');
    if (!label || !offers) return;
    const anyVisible = Array.from(offers.children).some(el => !el.classList.contains('hidden'));
    label.classList.toggle('hidden', !anyVisible);
    offers.classList.toggle('hidden', !anyVisible);
  }

  // Demo-mode fallback: if the Interest Checking account was opened while
  // Supabase was unavailable, reveal it from the locally cached flag. Applied
  // only when the server returned nothing — otherwise a stale cached figure
  // would sit in the deposits total next to the real accounts.
  function applyCachedInterestChecking() {
    try {
      if (localStorage.getItem('verceil_interest_checking_opened') !== '1') return;
      const cachedBalance = Number(localStorage.getItem('verceil_interest_checking_balance') || 0);
      applyAccountRow({ account_type: 'interest_checking', balance: cachedBalance });
    } catch (err) {}
  }

  if (!supabaseClient) applyCachedInterestChecking();

  if (supabaseClient) {
    try {
      const user = await getCurrentUser();
      if (user) {
        if (user.user_metadata && user.user_metadata.first_name) {
          userName = user.user_metadata.first_name;
        } else if (user.email) {
          userName = user.email.split('@')[0];
        }

        const { data: accountsData, error: accountsError } = await supabaseClient
          .from('accounts')
          .select('*')
          .eq('user_id', user.id);

        if (accountsData && !accountsError) {
          accountsData.forEach(applyAccountRow);
        }
        if (!accountsById.size) applyCachedInterestChecking();

        // Scoped to this user. An unfiltered subscription hands you every
        // other account holder's updates, and applyAccountRow would happily
        // fold a stranger's balance into these totals.
        supabaseClient
          .channel(`accounts:${user.id}`)
          .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'accounts',
            filter: `user_id=eq.${user.id}`,
          }, (payload) => {
            if (payload.eventType === 'DELETE') removeAccountRow(payload.old);
            else if (payload.new) applyAccountRow(payload.new);
          })
          .subscribe();
      } else {
        applyCachedInterestChecking();
      }
    } catch (err) {
      console.error('Supabase data fetch error:', err);
    }
  }

  renderTotals();
  refreshOffersLabel();

  greetingLine1.textContent = `${timeOfDay},`;
  greetingLine2.textContent = userName;
}

initSupabaseData();
refreshAlertsBadge();
// The routing number, the server-issued account numbers and whether a card is
// held are all read once here, then reused by every screen that needs them.
loadBankReference();

// Investments card sparkline. Runs on its own animation loop, and parks itself
// when the tab is hidden or the card scrolls out of view.
createLiveSparkline({
  line: document.getElementById('investSparkLine'),
  fill: document.getElementById('investSparkFill'),
  dot: document.getElementById('investSparkDot'),
  container: document.getElementById('investSparkWrap'),
});
