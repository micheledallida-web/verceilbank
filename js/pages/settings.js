// Settings — Quick Actions > Settings.
//
// Deliberately narrow. Everything here is something this device or this
// sign-in owns, and nothing here exists on another screen: alerts live on
// Notification Preferences, data sharing on Privacy & Data Settings, the
// record the bank holds on Profile, and cards on Card Services. What was left
// with no home at all was the password, how long a session may sit idle,
// signing every device out, and how the app looks — so that is what this is.

import { depositInsuranceDisclosure, depositInsuranceLabel } from '../shared/deposit-insurance.js';

const APP_VERSION = '1.0.0';

// The ladder Chase, Citi and the rest offer. There is no "never" on it, and
// that is the point: every bank caps how long a session may sit unattended,
// because the device it is sitting on is not always the one it was signed in
// on. The shortest option is the safest, not the longest.
const TIMEOUT_OPTIONS = [
  { minutes: 5, label: '5 min' },
  { minutes: 10, label: '10 min' },
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
];

const SEGMENT_ON = 'flex-1 h-[36px] rounded-[10px] text-[12px] font-semibold cursor-pointer bg-[#2563EB] text-white';
const SEGMENT_OFF = 'flex-1 h-[36px] rounded-[10px] text-[12px] font-semibold cursor-pointer bg-gray-100 dark:bg-white/5 text-[#6B7280] dark:text-[#8E9CBA]';

let listeners = [];
function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}

// One renderer for both segmented rows, so the appearance switch and the
// timeout switch can never drift apart visually.
function renderSegments(container, options, isSelected, onPick) {
  container.innerHTML = options.map((opt, idx) => `
    <button class="st-segment ${isSelected(opt) ? SEGMENT_ON : SEGMENT_OFF}" data-index="${idx}">${opt.label}</button>
  `).join('');

  container.querySelectorAll('.st-segment').forEach((btn) => {
    on(btn, 'click', () => {
      onPick(options[parseInt(btn.getAttribute('data-index'), 10)]);
      renderSegments(container, options, isSelected, onPick);
    });
  });
}

function paintToggle(btn, isOn) {
  btn.classList.toggle('bg-[#2563EB]', isOn);
  btn.classList.toggle('bg-gray-200', !isOn);
  btn.classList.toggle('dark:bg-white/10', !isOn);
  const thumb = btn.querySelector('.st-thumb');
  if (thumb) thumb.style.left = isOn ? '23px' : '3px';
}

export function init(root, ctx) {
  const {
    close, showModal, supabaseClient, applyTheme, isDarkTheme,
    readSettings, writeSettings, signOut, getAccountNumber,
  } = ctx;

  on(root.querySelector('[data-action="close"]'), 'click', close);

  // ---------- Change password ----------
  const passwordForm = root.querySelector('#stPasswordForm');
  const passwordChevron = root.querySelector('#stPasswordChevron');
  const passwordMsg = root.querySelector('#stPasswordMsg');

  function setPasswordMessage(text, isError) {
    passwordMsg.textContent = text;
    passwordMsg.style.color = isError ? '#EF4444' : '#16A34A';
    passwordMsg.classList.toggle('hidden', !text);
  }

  on(root.querySelector('#stPasswordRow'), 'click', () => {
    const opening = passwordForm.classList.contains('hidden');
    passwordForm.classList.toggle('hidden', !opening);
    passwordChevron.style.transform = opening ? 'rotate(90deg)' : '';
    if (!opening) setPasswordMessage('', false);
  });

  on(root.querySelector('#stSavePasswordBtn'), 'click', async () => {
    const btn = root.querySelector('#stSavePasswordBtn');
    const next = root.querySelector('#stNewPassword').value;
    const confirm = root.querySelector('#stConfirmPassword').value;

    // Checked here as well as by Supabase, so the common mistakes are answered
    // instantly rather than after a round-trip.
    if (next.length < 8) return setPasswordMessage('Use at least 8 characters.', true);
    if (next !== confirm) return setPasswordMessage('Those passwords do not match.', true);
    if (!supabaseClient) return setPasswordMessage('You are offline. Try again when reconnected.', true);

    btn.disabled = true;
    btn.textContent = 'Updating...';
    try {
      const { error } = await supabaseClient.auth.updateUser({ password: next });
      if (error) throw error;
      root.querySelector('#stNewPassword').value = '';
      root.querySelector('#stConfirmPassword').value = '';
      setPasswordMessage('Password updated.', false);
    } catch (err) {
      console.error('Password update error:', err);
      setPasswordMessage(err.message || 'Could not update your password. Please try again.', true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Update Password';
    }
  });

  // ---------- Automatic sign-out ----------
  renderSegments(
    root.querySelector('#stTimeoutOptions'),
    TIMEOUT_OPTIONS,
    (opt) => opt.minutes === readSettings().autoSignOutMinutes,
    (opt) => writeSettings({ autoSignOutMinutes: opt.minutes }),
  );

  // ---------- Sign out of all devices ----------
  // Supabase revokes the refresh token globally by default, so this is every
  // session on every device, not just this browser.
  on(root.querySelector('#stSignOutAllBtn'), 'click', () => {
    showModal('Signing Out Everywhere', 'Every device signed in to this account is being signed out.');
    signOut();
  });

  // ---------- Appearance ----------
  const THEME_OPTIONS = [
    { label: 'Light', dark: false },
    { label: 'Dark', dark: true },
  ];
  renderSegments(
    root.querySelector('#stThemeOptions'),
    THEME_OPTIONS,
    (opt) => opt.dark === isDarkTheme(),
    (opt) => applyTheme(opt.dark),
  );

  // ---------- Hide balances ----------
  const hideBalancesToggle = root.querySelector('#stHideBalancesToggle');
  paintToggle(hideBalancesToggle, readSettings().hideBalances);
  on(hideBalancesToggle, 'click', () => {
    const next = !readSettings().hideBalances;
    writeSettings({ hideBalances: next });
    paintToggle(hideBalancesToggle, next);
  });

  // ---------- About ----------
  root.querySelector('#stAppVersion').textContent = APP_VERSION;
  // The routing number is the bank's, identical for every customer, and needed
  // often enough that it earns a line someone can always find.
  root.querySelector('#stRoutingNumber').textContent = getAccountNumber('checking', 'routing');

  on(root.querySelector('#stLegalBtn'), 'click', () => showModal(
    'Terms & Disclosures',
    'Your accounts are governed by the Verceil Bank Deposit Account Agreement, Electronic Communications Agreement and Fee Schedule. Contact support for a copy of any of these documents.',
  ));

  // Label and body both come from the shared module: neither the row nor the
  // modal may assert insurance the Bank has not confirmed it carries.
  const fdicRow = root.querySelector('#stFdicBtn');
  const fdicLabel = fdicRow && fdicRow.querySelector('span');
  if (fdicLabel) fdicLabel.textContent = depositInsuranceLabel();

  on(fdicRow, 'click', () => showModal(
    depositInsuranceLabel() === 'FDIC insurance' ? 'FDIC Insurance' : 'Deposit Insurance',
    depositInsuranceDisclosure(),
  ));
}

export function cleanup() {
  listeners.forEach((off) => off());
  listeners = [];
}
