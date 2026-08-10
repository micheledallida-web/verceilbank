import { showConfirmation } from '../shared/profile-confirmation.js';
import { readProfile, writeProfile } from '../shared/profile-store.js';

let listeners = [];
let pendingCode = null;

function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}


export async function init(root, ctx) {
  const { loadPage, showModal } = ctx;

  root.querySelectorAll('[data-action="back"]').forEach((btn) => on(btn, 'click', () => loadPage('profile')));

  const profile = await readProfile(ctx);
  if (profile) {
    root.querySelector('#phCode').value = profile.phone_country_code || '+1';
    root.querySelector('#phNumber').value = profile.phone_number || '';
    root.querySelector('#phStatus').textContent = profile.phone_verified ? '✅ Verified' : 'Not verified';
    if (profile.phone_number) root.querySelector('#pdCurrentPhone').textContent = `${profile.phone_country_code || '+1'} ${profile.phone_number}`;
  }

  on(root.querySelector('#phSendCodeBtn'), 'click', () => {
    pendingCode = String(Math.floor(100000 + Math.random() * 900000));
    root.querySelector('#phVerifyRow').classList.remove('hidden');
    root.querySelector('#phVerifyRow').classList.add('flex');
    showModal('Verification Code Sent', `Demo mode — no SMS provider connected. Your code is: ${pendingCode}`);
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
    try {
      await writeProfile(ctx, { phone_country_code: code, phone_number: number });
      showConfirmation(root, ctx, { fieldLabel: 'Phone Number', valueText: `${code} ${number}`.trim() || '(212) 555-0188' });
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
