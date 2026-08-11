// Full Legal Name — Profile > Personal Information > Full Legal Name.
//
// Read-only, for the same reason the date of birth screen is: the name on the
// record was checked against a government ID, and a session cannot change what
// the bank has verified. No inputs, no save, and the correction route is a
// representative who can take the documents. Changing it in the database is an
// administrator's job.

let listeners = [];
function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}

// The name has been written by three different flows over the life of this
// app, so all three are read: the profile row the old editor wrote, the
// verification record a representative checked, and what was typed at sign-up.
async function readLegalName({ supabaseClient, getCurrentUser }) {
  const user = await getCurrentUser();
  if (!user) return {};
  const meta = user.user_metadata || {};

  const fromMeta = {
    first_name: meta.first_name || '',
    middle_name: meta.middle_name || '',
    last_name: meta.last_name || '',
    suffix: meta.suffix && meta.suffix !== 'None' ? meta.suffix : '',
  };

  if (!supabaseClient) return fromMeta;

  try {
    const [profileRes, verificationRes] = await Promise.all([
      supabaseClient.from('user_profile').select('*').eq('user_id', user.id).maybeSingle(),
      supabaseClient.from('verification_requests').select('*').eq('user_id', user.id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ]);
    const profile = profileRes.data || {};
    const ver = verificationRes.data || {};

    // Field by field rather than record by record: a profile row with only a
    // first name should not blank out a last name held elsewhere.
    const pick = (...values) => values.find((value) => value) || '';
    return {
      first_name: pick(profile.first_name, ver.legal_first_name, fromMeta.first_name),
      middle_name: pick(profile.middle_name, ver.legal_middle_name, fromMeta.middle_name),
      last_name: pick(profile.last_name, ver.legal_last_name, fromMeta.last_name),
      suffix: pick(profile.suffix, fromMeta.suffix),
    };
  } catch (err) {
    console.error('Legal name read error:', err);
    return fromMeta;
  }
}

export async function init(root, ctx) {
  const { loadPage, openSupportMessage } = ctx;

  root.querySelectorAll('[data-action="back"]').forEach((btn) => on(btn, 'click', () => loadPage('profile')));

  on(root.querySelector('#pnContactBtn'), 'click', () => openSupportMessage({
    category: 'personal_details',
    subject: 'Change to legal name',
    body: 'I need to change the legal name on my account. Please tell me what documentation you need.',
  }));

  const name = await readLegalName(ctx);
  const set = (id, value) => {
    const el = root.querySelector(id);
    // An em dash rather than an empty row: a middle name nobody has is not a
    // field that failed to load.
    if (el) el.textContent = value || '—';
  };
  set('#pnFirstName', name.first_name);
  set('#pnMiddleName', name.middle_name);
  set('#pnLastName', name.last_name);
  set('#pnSuffix', name.suffix && name.suffix !== 'None' ? name.suffix : '');
}

export function cleanup() {
  listeners.forEach((off) => off());
  listeners = [];
}
