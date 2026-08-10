import { showConfirmation } from '../shared/profile-confirmation.js';
import { readProfile, writeProfile } from '../shared/profile-store.js';

let listeners = [];
function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}


function toggleFields(root, sameAsResidential) {
  const fields = root.querySelector('#maFields');
  fields.classList.toggle('hidden', sameAsResidential);
  fields.classList.toggle('flex', !sameAsResidential);
}

export async function init(root, ctx) {
  const { loadPage, showModal } = ctx;

  root.querySelectorAll('[data-action="back"]').forEach((btn) => on(btn, 'click', () => loadPage('profile')));
  on(root.querySelector('#maSame'), 'change', (e) => toggleFields(root, e.target.checked));

  const profile = await readProfile(ctx);
  if (profile) {
    const same = profile.mail_same_as_res !== false;
    root.querySelector('#maSame').checked = same;
    root.querySelector('#maStreet').value = profile.mail_street || '';
    root.querySelector('#maCity').value = profile.mail_city || '';
    root.querySelector('#maState').value = profile.mail_state || '';
    root.querySelector('#maZip').value = profile.mail_zip || '';
    if (!same) {
      const line = [profile.mail_street, [profile.mail_city, profile.mail_state].filter(Boolean).join(', '), profile.mail_zip].filter(Boolean).join(', ');
      if (line) root.querySelector('#pdCurrentMail').textContent = line;
    }
  }
  toggleFields(root, root.querySelector('#maSame').checked);

  on(root.querySelector('#pdSaveBtn'), 'click', async () => {
    const same = root.querySelector('#maSame').checked;
    const street = root.querySelector('#maStreet').value.trim();
    const city = root.querySelector('#maCity').value.trim();
    const state = root.querySelector('#maState').value.trim();
    const zip = root.querySelector('#maZip').value.trim();

    try {
      await writeProfile(ctx, {
        mail_same_as_res: same,
        mail_street: same ? null : street,
        mail_city: same ? null : city,
        mail_state: same ? null : state,
        mail_zip: same ? null : zip,
      });
      const valueText = same ? 'Same as residential address' : ([street, [city, state].filter(Boolean).join(', '), zip].filter(Boolean).join(', ') || 'Mailing address updated');
      showConfirmation(root, ctx, { fieldLabel: 'Mailing Address', valueText });
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
}
