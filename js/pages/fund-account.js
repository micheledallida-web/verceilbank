// Fund Account — Payments > Fund Account. Three screens in one view: choose an
// amount (Screen 1), choose a funding method (Screen 2), then the Bitcoin
// deposit details (Screen 3). Opening the page always lands on Screen 1, and
// each screen is reachable only from the one before it.

// ---------------------------------------------------------------------------
// PLACEHOLDER DEPOSIT DATA — AWAITING BACKEND WIRING.
//
// This repo has no deposit data source yet, so the address and locked rate are
// declared here instead of being scattered through the markup. When a backend
// exists, replace this object with the values it returns for the current
// deposit request; nothing else in this file reads these values from anywhere
// else.
//
// The amounts are deliberately absent: the USD figure comes from what the user
// picks on Screen 1, and the BTC figure is derived from it at `rate`.
//
// `lockMinutes` is how long a quote is held. The expiry itself is an absolute
// timestamp persisted under `expiryKey`, so a reload shows the real remaining
// time rather than a fresh countdown.
//
// NOTE: `address` is the placeholder from the design. Its bech32 checksum is
// invalid, so wallets refuse to send to it — replace it with a real receiving
// address as part of the backend wiring.
// ---------------------------------------------------------------------------
const DEPOSIT = {
  address: 'bc1qh4kl29xf7ejm3wvp8dz6ncrt5aygu0svq2xlpe',
  rate: 106468.20,
  lockMinutes: 30,
  expiryKey: 'verceil_fund_deposit_expiry',
};

// The floor is the opening deposit every account is held to, not a separate
// rule this screen invented — a screen that accepted $25 while the rest of the
// app asked for $100 was telling people the deposit was made when it was not.
const MIN_USD = 100;
const MAX_USD = 100000;
// Matches the field's transform transition, so the class comes off once the
// pop has played and the next chip tap can replay it.
const BUMP_MS = 160;
const WARN_MS = 5 * 60 * 1000;
const COPIED_MS = 1600;

let listeners = [];
function on(el, evt, fn) { if (!el) return; el.addEventListener(evt, fn); listeners.push(() => el.removeEventListener(evt, fn)); }

let tickHandle = null;
let copyHandle = null;
let bumpHandle = null;

function lockDurationMs() {
  return DEPOSIT.lockMinutes * 60 * 1000;
}

function formatUsd(amount) {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Rounded up to the satoshi: the deposit screen warns that underpayments are
// not credited, so rounding down would set that trap by a hair.
function usdToBtc(amount) {
  return (Math.ceil((amount / DEPOSIT.rate) * 1e8) / 1e8).toFixed(8);
}

// The countdown runs off an absolute timestamp so a reload can't hand someone
// a fresh 30 minutes on a quote that is nearly up.
function readExpiry() {
  let stored = null;
  try { stored = localStorage.getItem(DEPOSIT.expiryKey); } catch (err) {}
  const parsed = Number(stored);
  if (stored && isFinite(parsed) && parsed > 0) return parsed;
  return writeExpiry();
}

function writeExpiry() {
  const expiry = Date.now() + lockDurationMs();
  try { localStorage.setItem(DEPOSIT.expiryKey, String(expiry)); } catch (err) {}
  return expiry;
}

function clearExpiry() {
  try { localStorage.removeItem(DEPOSIT.expiryKey); } catch (err) {}
}

export function init(root, ctx) {
  const { close } = ctx;

  // Why someone is most likely on this screen at all: the opening deposit.
  // Stated here so the amount they need is in front of them while they type
  // one, rather than only on the home screen that sent them.
  const openingTerms = root.querySelector('#fundOpeningTerms');
  if (openingTerms && ctx.MINIMUM_OPENING_DEPOSIT) {
    openingTerms.textContent = `Your accounts need a ${ctx.MINIMUM_OPENING_DEPOSIT_LABEL} opening deposit within ${ctx.FUNDING_DEADLINE_DAYS} days of opening for full access. An account left unfunded past that is closed.`;
    openingTerms.classList.remove('hidden');
  }

  const backBtn = root.querySelector('[data-action="close"]');
  // The header markup is shared by every screen, so the title is the back
  // button's sibling rather than a screen-specific element.
  const titleEl = backBtn.nextElementSibling;

  const amountScreen = root.querySelector('#fundAmountScreen');
  const methodScreen = root.querySelector('#fundMethodScreen');
  const depositScreen = root.querySelector('#fundDepositScreen');

  const amountBox = root.querySelector('#fundAmountBox');
  const amountField = root.querySelector('#fundAmountField');
  const amountCur = root.querySelector('#fundAmountCur');
  const amountInput = root.querySelector('#fundAmountInput');
  const amountMeta = root.querySelector('#fundAmountMeta');
  const amountChips = root.querySelectorAll('.fund-amount-chip');
  const continueBtn = root.querySelector('#fundContinueBtn');

  const timerValue = root.querySelector('#fundTimerValue');
  const timerBar = root.querySelector('#fundTimerBar');

  const amountCard = root.querySelector('#fundAmountCard');
  const btcAmountEl = root.querySelector('#fundBtcAmount');
  const usdAmountEl = root.querySelector('#fundUsdAmount');
  const rateLineEl = root.querySelector('#fundRateLine');

  const qrCard = root.querySelector('#fundQrCard');
  const qrBox = root.querySelector('#fundQrBox');
  const qrHolder = root.querySelector('#fundQrHolder');
  const addressEl = root.querySelector('#fundAddress');
  const copyBtn = root.querySelector('#fundCopyBtn');

  const buy = root.querySelector('#fundBuy');
  const buyHead = root.querySelector('#fundBuyHead');

  const statusTitle = root.querySelector('#fundStatusTitle');
  const statusSub = root.querySelector('#fundStatusSub');

  const cancelBtn = root.querySelector('#fundCancelBtn');
  const restartBtn = root.querySelector('#fundRestartBtn');

  let expiry = 0;
  // What the user chose on Screen 1. Everything the deposit screen shows in
  // dollars or bitcoin is derived from this.
  let chosenUsd = 0;

  // ---------- Amount ----------
  function typedUsd() {
    return parseFloat(amountInput.value.replace(/,/g, '')) || 0;
  }

  // One status line carries the range hint, both bound complaints and the
  // all-clear, so the card never grows or shrinks as the value changes.
  function renderAmount() {
    chosenUsd = typedUsd();
    const entered = amountInput.value.trim() !== '';
    amountCur.classList.toggle('fund-amount-dim', !entered);

    if (!entered) {
      amountMeta.textContent = `Enter ${formatUsd(MIN_USD)} – ${formatUsd(MAX_USD)}`;
      amountMeta.classList.remove('fund-amount-bad');
      continueBtn.disabled = true;
    } else if (chosenUsd < MIN_USD) {
      amountMeta.textContent = `Minimum deposit is ${formatUsd(MIN_USD)}`;
      amountMeta.classList.add('fund-amount-bad');
      continueBtn.disabled = true;
    } else if (chosenUsd > MAX_USD) {
      amountMeta.textContent = `Maximum deposit is ${formatUsd(MAX_USD)}`;
      amountMeta.classList.add('fund-amount-bad');
      continueBtn.disabled = true;
    } else {
      amountMeta.textContent = 'Ready to continue';
      amountMeta.classList.remove('fund-amount-bad');
      continueBtn.disabled = false;
    }

    // A chip lights up whenever the amount equals it, however it was reached —
    // typing 250 and tapping $250 land in the same place.
    amountChips.forEach((chip) => {
      const preset = Number(chip.getAttribute('data-amount'));
      chip.classList.toggle('fund-amount-chip-on', entered && chosenUsd === preset);
    });
  }

  function bumpField() {
    amountField.classList.remove('fund-amount-bump');
    // Force a reflow so re-adding the class restarts the transition rather
    // than being coalesced into no change at all.
    void amountField.offsetWidth;
    amountField.classList.add('fund-amount-bump');
    if (bumpHandle) clearTimeout(bumpHandle);
    bumpHandle = setTimeout(() => {
      amountField.classList.remove('fund-amount-bump');
      bumpHandle = null;
    }, BUMP_MS);
  }

  amountChips.forEach((chip) => {
    on(chip, 'click', () => {
      amountInput.value = Number(chip.getAttribute('data-amount')).toFixed(2);
      bumpField();
      renderAmount();
    });
  });

  // Digits and a single dot, at most two decimals — written back into the
  // field so what is typed and what is read are never different numbers.
  on(amountInput, 'input', () => {
    let raw = amountInput.value.replace(/[^0-9.]/g, '');
    const parts = raw.split('.');
    if (parts.length > 2) raw = parts[0] + '.' + parts.slice(1).join('');
    if (parts[1] && parts[1].length > 2) raw = parts[0] + '.' + parts[1].slice(0, 2);
    amountInput.value = raw;
    renderAmount();
  });

  on(amountInput, 'focus', () => amountBox.classList.add('fund-amount-focus'));

  on(amountInput, 'blur', () => {
    amountBox.classList.remove('fund-amount-focus');
    if (amountInput.value.trim() !== '') amountInput.value = typedUsd().toFixed(2);
    renderAmount();
  });

  // The whole card is the tap target for the field.
  on(amountBox, 'click', (event) => {
    if (event.target !== amountInput) amountInput.focus();
  });

  on(continueBtn, 'click', () => {
    if (chosenUsd < MIN_USD || chosenUsd > MAX_USD) return;
    showMethodScreen();
  });

  // ---------- Deposit details ----------
  // Everything on the deposit screen that carries a value comes from the
  // chosen amount and DEPOSIT, so the markup holds no deposit literals.
  function renderDeposit() {
    btcAmountEl.textContent = `${usdToBtc(chosenUsd)} BTC`;
    usdAmountEl.textContent = `≈ ${formatUsd(chosenUsd)} USD`;
    rateLineEl.textContent = `1 BTC = ${formatUsd(DEPOSIT.rate)} · locked at this rate`;
    addressEl.textContent = DEPOSIT.address;
    renderQr();
  }

  // A QR that encodes nothing is worse than no QR at all, so if generation
  // fails for any reason the whole container is hidden and the text address
  // carries the screen on its own.
  function renderQr() {
    qrHolder.innerHTML = '';
    qrBox.classList.remove('fund-hidden');
    const uri = `bitcoin:${DEPOSIT.address}?amount=${usdToBtc(chosenUsd)}`;
    try {
      if (typeof window.QRCode !== 'function') throw new Error('QR library unavailable');
      new window.QRCode(qrHolder, {
        text: uri,
        width: 180,
        height: 180,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: window.QRCode.CorrectLevel.M,
      });
      if (!qrHolder.querySelector('canvas, img, table, svg')) throw new Error('QR renderer produced nothing');
    } catch (err) {
      console.error('Deposit QR could not be generated:', err);
      qrHolder.innerHTML = '';
      qrBox.classList.add('fund-hidden');
    }
  }

  // ---------- Countdown ----------
  function renderTimer() {
    const remaining = Math.max(0, expiry - Date.now());
    if (remaining <= 0) {
      expire();
      return;
    }

    const seconds = Math.ceil(remaining / 1000);
    const minutes = Math.floor(seconds / 60);
    timerValue.textContent = `${minutes}:${String(seconds % 60).padStart(2, '0')}`;

    const pct = Math.max(0, Math.min(100, (remaining / lockDurationMs()) * 100));
    timerBar.style.width = `${pct}%`;

    const warning = remaining <= WARN_MS;
    timerValue.classList.toggle('fund-warn', warning);
    timerBar.classList.toggle('fund-warn', warning);
  }

  function startTimer() {
    stopTimer();
    renderTimer();
    if (expiry - Date.now() > 0) tickHandle = setInterval(renderTimer, 1000);
  }

  function stopTimer() {
    if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
  }

  function expire() {
    stopTimer();
    timerValue.textContent = 'Expired';
    timerValue.classList.add('fund-warn');
    timerBar.classList.add('fund-warn');
    timerBar.style.width = '0%';
    amountCard.classList.add('fund-dim');
    qrCard.classList.add('fund-dim');
    statusTitle.textContent = 'This deposit request expired';
    statusSub.classList.add('fund-hidden');
    cancelBtn.classList.add('fund-hidden');
    restartBtn.classList.remove('fund-hidden');
  }

  function revive() {
    timerValue.classList.remove('fund-warn');
    timerBar.classList.remove('fund-warn');
    amountCard.classList.remove('fund-dim');
    qrCard.classList.remove('fund-dim');
    statusTitle.textContent = 'Awaiting your payment';
    statusSub.classList.remove('fund-hidden');
    cancelBtn.classList.remove('fund-hidden');
    restartBtn.classList.add('fund-hidden');
  }

  // ---------- Screens ----------
  function showAmountScreen() {
    stopTimer();
    methodScreen.classList.remove('fund-screen-active');
    depositScreen.classList.remove('fund-screen-active');
    amountScreen.classList.add('fund-screen-active');
    titleEl.textContent = 'Fund Account';
    root.scrollTop = 0;
  }

  function showMethodScreen() {
    stopTimer();
    amountScreen.classList.remove('fund-screen-active');
    depositScreen.classList.remove('fund-screen-active');
    methodScreen.classList.add('fund-screen-active');
    titleEl.textContent = 'Fund Account';
    root.scrollTop = 0;
  }

  function showDepositScreen() {
    amountScreen.classList.remove('fund-screen-active');
    methodScreen.classList.remove('fund-screen-active');
    depositScreen.classList.add('fund-screen-active');
    titleEl.textContent = 'Deposit Bitcoin';
    root.scrollTop = 0;

    expiry = readExpiry();
    if (expiry - Date.now() > 0) revive();
    renderDeposit();
    startTimer();
  }

  // The back arrow steps back one screen at a time, and only closes the page
  // from the first one.
  on(backBtn, 'click', () => {
    if (depositScreen.classList.contains('fund-screen-active')) showMethodScreen();
    else if (methodScreen.classList.contains('fund-screen-active')) showAmountScreen();
    else close();
  });

  on(root.querySelector('#fundMethodBitcoin'), 'click', showDepositScreen);
  on(cancelBtn, 'click', showMethodScreen);

  on(restartBtn, 'click', () => {
    clearExpiry();
    expiry = writeExpiry();
    revive();
    renderDeposit();
    startTimer();
  });

  // ---------- Address ----------
  function markCopied() {
    copyBtn.textContent = 'Copied';
    copyBtn.classList.add('fund-done');
    if (copyHandle) clearTimeout(copyHandle);
    copyHandle = setTimeout(() => {
      copyBtn.textContent = 'Copy';
      copyBtn.classList.remove('fund-done');
      copyHandle = null;
    }, COPIED_MS);
  }

  // No clipboard API (older or non-secure contexts): select the address so it
  // can be copied by hand.
  function selectAddress() {
    const range = document.createRange();
    range.selectNodeContents(addressEl);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  on(copyBtn, 'click', () => {
    if (!navigator.clipboard) {
      selectAddress();
      return;
    }
    navigator.clipboard.writeText(DEPOSIT.address).then(markCopied).catch(selectAddress);
  });

  // ---------- Other payment methods ----------
  // None of these four rows shows a handle, tag, address, account number or
  // routing number, and none of them fetches one. Those details are issued per
  // request, so the row's whole job is to open a support message already
  // carrying the right category — which is the only place they are ever given
  // out, to one person, once.
  const SUPPORT_FUNDING = {
    zelle: { category: 'funding_zelle', subject: 'Zelle funding request', label: 'Zelle' },
    cashapp: { category: 'funding_cashapp', subject: 'Cash App funding request', label: 'Cash App' },
    paypal: { category: 'funding_paypal', subject: 'PayPal funding request', label: 'PayPal' },
    ach: { category: 'funding_ach', subject: 'ACH funding request', label: 'ACH transfer' },
  };

  function requestFundingDetails(key) {
    const method = SUPPORT_FUNDING[key];
    if (!method || !ctx.openSupportMessage) return;
    // The amount rides along only when one was actually entered, so a request
    // made without it never claims a figure the user did not choose.
    const body = chosenUsd > 0
      ? `I would like to fund my account with ${formatUsd(chosenUsd)} via ${method.label}. Please send me the details.`
      : `I would like to fund my account via ${method.label}. Please send me the details.`;
    ctx.openSupportMessage({ category: method.category, subject: method.subject, body });
  }

  root.querySelectorAll('[data-fund-support]').forEach((row) => {
    const key = row.getAttribute('data-fund-support');
    on(row, 'click', () => requestFundingDetails(key));
    on(row, 'keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      requestFundingDetails(key);
    });
  });

  // ---------- Buy Bitcoin ----------
  on(buyHead, 'click', () => {
    buy.classList.toggle('fund-open');
  });

  renderAmount();
}

export function cleanup() {
  if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
  if (copyHandle) { clearTimeout(copyHandle); copyHandle = null; }
  if (bumpHandle) { clearTimeout(bumpHandle); bumpHandle = null; }
  listeners.forEach(off => off());
  listeners = [];
}
