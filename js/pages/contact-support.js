let listeners = [];
function on(el, evt, fn) { if (!el) return; el.addEventListener(evt, fn); listeners.push(() => el.removeEventListener(evt, fn)); }

export function init(root, ctx) {
  const { supabaseClient, getCurrentUser, genRef, showModal, loadPage, close } = ctx;

  const callbackFormWrap = root.querySelector('#callbackFormWrap');
  const callbackPhone = root.querySelector('#callbackPhone');
  const callbackTime = root.querySelector('#callbackTime');
  const callbackTopic = root.querySelector('#callbackTopic');
  const callbackError = root.querySelector('#callbackError');
  const callbackSubmitBtn = root.querySelector('#callbackSubmitBtn');

  on(root.querySelector('[data-action="close"]'), 'click', close);
  on(root.querySelector('#contactCallbackBtn'), 'click', () => callbackFormWrap.classList.toggle('hidden'));
  on(root.querySelector('#contactVideoBtn'), 'click', () => {
    showModal('Video Banking', 'Video banking sessions require a scheduled slot with an available specialist. This feature is coming soon.');
  });
  on(root.querySelector('#contactBranchBtn'), 'click', async () => {
    try {
      if (!supabaseClient) throw new Error('Supabase client not available');
      const user = await getCurrentUser();
      if (!user) throw new Error('Not signed in');
      await supabaseClient.from('support_requests').insert({
        user_id: user.id,
        request_type: 'branch_appointment',
        status: 'pending',
      });
      showModal('Branch Appointment Requested', `A specialist will contact you to confirm your branch appointment. Reference: ${genRef()}`);
    } catch (e) {
      console.error('Branch appointment error:', e);
      showModal('Unable to Request Appointment', 'We could not submit your branch appointment request right now. Please try again later.');
    }
  });

  on(callbackSubmitBtn, 'click', async () => {
    callbackError.classList.add('hidden');
    const phone = callbackPhone.value.trim();
    const time = callbackTime.value;
    const topic = callbackTopic.value.trim();
    if (!phone || !time) {
      callbackError.textContent = 'Please enter a phone number and preferred time.';
      callbackError.classList.remove('hidden');
      return;
    }
    callbackSubmitBtn.disabled = true;
    callbackSubmitBtn.textContent = 'Requesting...';
    try {
      if (!supabaseClient) throw new Error('Supabase client not available');
      const user = await getCurrentUser();
      if (!user) throw new Error('Not signed in');
      const ref = genRef();
      const { error } = await supabaseClient.from('support_requests').insert({
        user_id: user.id,
        request_type: 'callback',
        phone,
        preferred_time: time,
        topic,
        status: 'pending',
        reference_number: ref,
      });
      if (error) throw error;
      callbackFormWrap.classList.add('hidden');
      callbackPhone.value = '';
      callbackTime.value = '';
      callbackTopic.value = '';
      showModal('Callback Scheduled', `We'll call you at ${phone}. Reference: ${ref}`);
    } catch (e) {
      console.error('Callback schedule error:', e);
      callbackError.textContent = 'Could not schedule this callback.';
      callbackError.classList.remove('hidden');
    } finally {
      callbackSubmitBtn.disabled = false;
      callbackSubmitBtn.textContent = 'Request Callback';
    }
  });
}

export function cleanup() {
  listeners.forEach(off => off());
  listeners = [];
}
