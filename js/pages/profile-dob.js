// Date of Birth — Profile > Personal Information > Date of Birth.
//
// Read-only. This is one of the two fields the bank's record of a person rests
// on, checked against a government ID at verification, so it is not something
// a session can change: the screen has no input, the module has no save, and
// the only route to a correction is a representative who can evidence it.
// Changing it in the database is an administrator's job.

let listeners = [];
function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}

function formatDob(value) {
  if (!value) return '';
  const [year, month, day] = String(value).split('-').map(Number);
  if (!year || !month || !day) return '';
  const d = new Date(year, month - 1, day);
  return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// Three places have held a date of birth over the life of this app — the
// profile row, the verification record and what was typed at sign-up — so all
// three are read and whichever is on file is shown.
async function readDateOfBirth({ supabaseClient, getCurrentUser }) {
  const user = await getCurrentUser();
  if (!user) return '';
  const meta = (user.user_metadata) || {};

  if (!supabaseClient) return meta.date_of_birth || meta.dob || '';

  try {
    const [profileRes, verificationRes] = await Promise.all([
      supabaseClient.from('user_profile').select('date_of_birth').eq('user_id', user.id).maybeSingle(),
      supabaseClient.from('verification_requests').select('date_of_birth').eq('user_id', user.id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ]);
    return (profileRes.data && profileRes.data.date_of_birth)
      || (verificationRes.data && verificationRes.data.date_of_birth)
      || meta.date_of_birth || meta.dob || '';
  } catch (err) {
    console.error('Date of birth read error:', err);
    return meta.date_of_birth || meta.dob || '';
  }
}

export async function init(root, ctx) {
  const { loadPage, openSupportMessage } = ctx;

  root.querySelectorAll('[data-action="back"]').forEach((btn) => on(btn, 'click', () => loadPage('profile')));

  on(root.querySelector('#pdContactBtn'), 'click', () => openSupportMessage({
    category: 'Account',
    subject: 'Correction to date of birth',
    body: 'The date of birth on my account is incorrect. Please tell me what documentation you need to correct it.',
  }));

  const dob = await readDateOfBirth(ctx);
  const el = root.querySelector('#pdCurrentDob');
  if (el) el.textContent = formatDob(dob) || 'Not on file';
}

export function cleanup() {
  listeners.forEach((off) => off());
  listeners = [];
}
