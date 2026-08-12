let listeners = [];
let privacySettings = { data_sharing: false, marketing: false, cookies: true };

function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
  listeners.push(() => el.removeEventListener(evt, fn));
}

function setToggleState(btn, onState) {
  btn.classList.toggle('bg-[#2563EB]', onState);
  btn.classList.toggle('bg-gray-200', !onState);
  btn.classList.toggle('dark:bg-white/10', !onState);
  const thumb = btn.querySelector('.privacy-thumb');
  if (thumb) thumb.style.left = onState ? '23px' : '3px';
}

export async function init(root, ctx) {
  const { loadPage, supabaseClient, getCurrentUser, showModal } = ctx;
  on(root.querySelector('[data-action="back"]'), 'click', () => loadPage('profile'));

  try {
    const user = await getCurrentUser();
    if (user && supabaseClient) {
      const { data } = await supabaseClient.from('privacy_settings').select('*').eq('user_id', user.id).maybeSingle();
      if (data) privacySettings = data;
    }
  } catch (err) {
    console.error(err);
  }

  root.querySelectorAll('.privacy-toggle').forEach((btn) => {
    const key = btn.getAttribute('data-key');
    setToggleState(btn, !!privacySettings[key]);
    on(btn, 'click', async () => {
      privacySettings[key] = !privacySettings[key];
      setToggleState(btn, !!privacySettings[key]);
      try {
        const user = await getCurrentUser();
        if (user && supabaseClient) await supabaseClient.from('privacy_settings').upsert({ user_id: user.id, ...privacySettings }, { onConflict: 'user_id' });
      } catch (err) {
        console.error(err);
      }
    });
  });

  on(root.querySelector('#privacyDownloadBtn'), 'click', async () => {
    try {
      const user = await getCurrentUser();
      const [profileResp, holdingsResp] = user && supabaseClient ? await Promise.all([
        supabaseClient.from('user_profile').select('*').eq('user_id', user.id).maybeSingle(),
        supabaseClient.from('investment_portfolio').select('*').eq('user_id', user.id),
      ]) : [{ data: null }, { data: [] }];

      const exportData = {
        profile: profileResp.data,
        holdings: holdingsResp.data || [],
        checkingBalance: document.getElementById('checkingBalance')?.textContent,
        savingsBalance: document.getElementById('savingsBalance')?.textContent,
        investmentsBalance: document.getElementById('investmentsBalance')?.textContent,
        exportedAt: new Date().toISOString(),
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'verceil-bank-personal-data.json';
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      showModal('Could Not Export', 'Please try again.');
    }
  });

  on(root.querySelector('#privacyDeleteBtn'), 'click', async () => {
    try {
      const user = await getCurrentUser();
      if (!user || !supabaseClient) throw new Error('no user');
      await supabaseClient.from('linked_accounts').delete().eq('user_id', user.id);
      showModal('Linked Data Deleted', 'Your linked brokerage and payment provider connections have been removed. External bank links under Linked Accounts are unaffected.');
    } catch (err) {
      console.error(err);
      showModal('Could Not Delete', 'Please try again.');
    }
  });

  on(root.querySelector('#privacyPolicyBtn'), 'click', () => showModal('Privacy Policy', 'The full Verceil Bank Privacy Policy will be linked here.'));
}

export function cleanup() {
  listeners.forEach((off) => off());
  listeners = [];
  privacySettings = { data_sharing: false, marketing: false, cookies: true };
}
