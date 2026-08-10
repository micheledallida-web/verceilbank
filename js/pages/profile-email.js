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
  const { loadPage, showModal, getCurrentUser } = ctx;

  root.querySelectorAll('[data-action="back"]').forEach((btn) => on(btn, 'click', () => loadPage('profile')));

  const profile = await readProfile(ctx);
  const currentUser = await getCurrentUser();
  const emailValue = (profile && profile.email) || (currentUser && currentUser.email) || '';
  root.querySelector('#emEmail').value = emailValue;
  if (emailValue) root.querySelector('#pdCurrentEmail').textContent = emailValue;
  root.querySelector('#emStatus').textContent = profile && profile.email_verified ? '✅ Verified' : 'Not verified';

  on(root.querySelector('#emSendCodeBtn'), 'click', () => {
    pendingCode = String(Math.floor(100000 + Math.random() * 900000));
    root.querySelector('#emVerifyRow').classList.remove('hidden');
    root.querySelector('#emVerifyRow').classList.add('flex');
    showModal('Verification Email Sent', `Demo mode — no email provider connected. Your code is: ${pendingCode}`);
  });

  on(root.querySelector('#emVerifyBtn'), 'click', async () => {
    if (root.querySelector('#emCodeInput').value.trim() !== pendingCode) {
      showModal('Incorrect Code', 'That code did not match. Please try again.');
      return;
    }
    try {
      await writeProfile(ctx, { email_verified: true });
      root.querySelector('#emStatus').textContent = '✅ Verified';
      root.querySelector('#emVerifyRow').classList.add('hidden');
      showModal('Email Verified', 'Your email address has been verified.');
    } catch (err) {
      console.error(err);
      showModal('Could Not Verify', 'Please try again.');
    }
  });

  on(root.querySelector('#pdSaveBtn'), 'click', async () => {
    const email = root.querySelector('#emEmail').value.trim();
    try {
      await writeProfile(ctx, { email });
      showConfirmation(root, ctx, { fieldLabel: 'Email Address', valueText: email || 'mercy.johnson@email.com' });
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
