// Phone Number — Profile > Phone Number.
//
// A phone number is not an ordinary field on a bank's record. It is the thing
// the bank sends one-time codes to, so somebody who reads it off a screen has
// the first half of taking an account over. It is treated here the way every
// major bank treats it, and the rule is the same one the profile sheet follows:
// nobody sees a customer's number because a screen happened to open.
//
//   • The number on file is MASKED when the screen opens — the last four
//     digits and nothing else, which is enough to recognise it as yours.
//   • A Show control reveals it, and says Hide once it has. Revealing your own
//     phone number is a thing you choose to do, and it lasts exactly as long as
//     this screen is open: the module is torn down on close, so coming back
//     always starts masked again.
//   • Changing it means typing the new number out. The field is never
//     pre-filled with what is on record, which would put the digits back on
//     screen and make the mask decorative.

import { showConfirmation } from '../shared/profile-confirmation.js';
import { readProfile, writeProfile } from '../shared/profile-store.js';

let listeners = [];
let pendingCode = null;

function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}

// ---------- Printing a phone number ----------
// Ten digits are grouped the way an American number is written; anything else
// is left as the customer typed it, because a number this app does not
// recognise is more likely to be an international one than a mistake.
function formatPhoneNumber(dialCode, rawNumber) {
  const digits = String(rawNumber || '').replace(/\D/g, '');
  const code = String(dialCode || '').trim();
  const national = digits.length === 10
    ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    : String(rawNumber || '').trim();
  return [code, national].filter(Boolean).join(' ');
}

// The masked form. The shape of the number survives — the brackets, the dash,
// the grouping — so it still reads as a phone number, while every digit that
// is not one of the last four is gone. A shorter number is masked whole rather
// than being given a shape it does not have.
function maskPhoneNumber(dialCode, rawNumber) {
  const digits = String(rawNumber || '').replace(/\D/g, '');
  if (!digits) return '';
  const code = String(dialCode || '').trim();
  const national = digits.length === 10
    ? `(•••) •••-${digits.slice(-4)}`
    : `${'•'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
  return [code, national].filter(Boolean).join(' ');
}


export async function init(root, ctx) {
  const { loadPage, showModal } = ctx;

  root.querySelectorAll('[data-action="back"]').forEach((btn) => on(btn, 'click', () => loadPage('profile')));

  const currentEl = root.querySelector('#pdCurrentPhone');
  const revealBtn = root.querySelector('#phRevealBtn');

  // What is on file, and whether it is currently being shown. `revealed` starts
  // false on every open of this screen and is never persisted.
  let onFile = { code: '+1', number: '' };
  let revealed = false;

  function renderCurrent() {
    if (!onFile.number) {
      currentEl.textContent = 'Not added';
      currentEl.classList.add('text-[#6B7280]', 'dark:text-[#8E9CBA]');
      revealBtn.classList.add('hidden');
      return;
    }
    currentEl.classList.remove('text-[#6B7280]', 'dark:text-[#8E9CBA]');
    currentEl.textContent = revealed
      ? formatPhoneNumber(onFile.code, onFile.number)
      : maskPhoneNumber(onFile.code, onFile.number);
    revealBtn.textContent = revealed ? 'Hide' : 'Show';
    revealBtn.setAttribute('aria-pressed', String(revealed));
    revealBtn.setAttribute('aria-label', revealed ? 'Hide phone number' : 'Show phone number');
    revealBtn.classList.remove('hidden');
  }

  on(revealBtn, 'click', () => {
    revealed = !revealed;
    ctx.recordEvent(revealed ? 'profile.phone_revealed' : 'profile.phone_hidden', {});
    renderCurrent();
  });

  const profile = await readProfile(ctx);
  if (profile) {
    onFile = {
      code: profile.phone_country_code || '+1',
      number: profile.phone_number || '',
    };
    root.querySelector('#phCode').value = onFile.code;
    root.querySelector('#phStatus').textContent = profile.phone_verified ? '✅ Verified' : 'Not verified';
  }
  renderCurrent();

  // The code goes to the number on file, not to whatever is half-typed in the
  // field below — that one has not been saved yet and may not be the
  // customer's. With no number on record there is nowhere to send it.
  on(root.querySelector('#phSendCodeBtn'), 'click', () => {
    if (!onFile.number) {
      showModal('No Number On File', 'Add a mobile number and save it first. We will send the code to that number.');
      return;
    }
    pendingCode = String(Math.floor(100000 + Math.random() * 900000));
    root.querySelector('#phVerifyRow').classList.remove('hidden');
    root.querySelector('#phVerifyRow').classList.add('flex');
    // The destination is named the way a bank names it: masked, so the message
    // confirms where the code went without printing the number to do it.
    showModal(
      'Verification Code Sent',
      `Demo mode — no SMS provider connected. A code for ${maskPhoneNumber(onFile.code, onFile.number)} would be sent here. Your code is: ${pendingCode}`,
    );
  });

  on(root.querySelector('#phVerifyBtn'), 'click', async () => {
    if (root.querySelector('#phCodeInput').value.trim() !== pendingCode) {
      showModal('Incorrect Code', 'That code did not match. Please try again.');
      return;
    }
    try {
      await writeProfile(ctx, { phone_verified: true });
      root.querySelector('#phStatus').textContent = '✅ Verified';
      root.querySelector('#phVerifyRow').classList.add('hidden');
      showModal('Phone Verified', 'Your phone number has been verified.');
    } catch (err) {
      console.error(err);
      showModal('Could Not Verify', 'Please try again.');
    }
  });

  on(root.querySelector('#pdSaveBtn'), 'click', async () => {
    const code = root.querySelector('#phCode').value.trim();
    const number = root.querySelector('#phNumber').value.trim();

    // An empty field means nothing was typed, not "delete my phone number".
    // Saving it used to write a blank over the record and then report success
    // against a made-up number, so the customer was told their number was
    // (212) 555-0188 while the bank held none at all.
    if (!number.replace(/\D/g, '')) {
      showModal('Enter a Phone Number', 'Type the new mobile number you want on your account, then save.');
      return;
    }

    try {
      await writeProfile(ctx, { phone_country_code: code, phone_number: number, phone_verified: false });
      // On file now, so the masked line above reflects the change without a
      // reload — and it goes back to masked, because this is a new number the
      // customer has just this second typed and does not need read back.
      onFile = { code: code || '+1', number };
      revealed = false;
      renderCurrent();
      root.querySelector('#phNumber').value = '';
      root.querySelector('#phStatus').textContent = 'Not verified';
      showConfirmation(root, ctx, {
        fieldLabel: 'Phone Number',
        valueText: formatPhoneNumber(code, number),
      });
    } catch (err) {
      console.error(err);
      // The store's message says what actually went wrong — a missing column,
      // a policy refusal, a lost connection — rather than asking somebody to
      // repeat an action that cannot succeed until something is fixed.
      showModal('Could not save', err.message);
    }
  });
}

export function cleanup() {
  listeners.forEach((off) => off());
  listeners = [];
  pendingCode = null;
}
