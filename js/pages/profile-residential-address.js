import { showConfirmation } from '../shared/profile-confirmation.js';
import { readProfile, writeProfile } from '../shared/profile-store.js';

let listeners = [];
function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}


function formatAddress({ street, apt, city, state, zip }) {
  const line1 = [street, apt].filter(Boolean).join(' ');
  const line2 = [city, state].filter(Boolean).join(', ');
  return [line1, [line2, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

export async function init(root, ctx) {
  const { loadPage, showModal } = ctx;

  root.querySelectorAll('[data-action="back"]').forEach((btn) => on(btn, 'click', () => loadPage('profile')));

  const profile = await readProfile(ctx);
  if (profile) {
    root.querySelector('#raStreet').value = profile.res_street || '';
    root.querySelector('#raApt').value = profile.res_apt || '';
    root.querySelector('#raCity').value = profile.res_city || '';
    root.querySelector('#raState').value = profile.res_state || '';
    root.querySelector('#raZip').value = profile.res_zip || '';
    root.querySelector('#raCountry').value = profile.res_country || 'United States';
    const current = formatAddress({
      street: profile.res_street, apt: profile.res_apt, city: profile.res_city, state: profile.res_state, zip: profile.res_zip,
    });
    if (current) root.querySelector('#pdCurrentAddress').textContent = current;
  }

  on(root.querySelector('#pdSaveBtn'), 'click', async () => {
    const street = root.querySelector('#raStreet').value.trim();
    const apt = root.querySelector('#raApt').value.trim();
    const city = root.querySelector('#raCity').value.trim();
    const state = root.querySelector('#raState').value.trim();
    const zip = root.querySelector('#raZip').value.trim();
    const country = root.querySelector('#raCountry').value.trim();

    try {
      await writeProfile(ctx, { res_street: street, res_apt: apt, res_city: city, res_state: state, res_zip: zip, res_country: country });
      const valueText = formatAddress({ street, apt, city, state, zip }) || '123 Main Street, New York, NY 10001';
      showConfirmation(root, ctx, { fieldLabel: 'Residential Address', valueText });
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
