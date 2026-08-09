// Identity verification (KYC). One view, four states, driven by
// profiles.kyc_status: pending / verified / rejected show a status panel, and
// anything else (including null) shows the submission form. The form is never
// shown to someone who has already submitted — that is what keeps a
// representative from receiving the same documents twice.
//
// Documents go to the private `kyc-documents` storage bucket under the user's
// own id, then one row lands in verification_requests, and only once that row
// is in does profiles.kyc_status flip to 'pending'. That order matters: a
// profile marked pending with no request behind it would strand the user in a
// review queue that has nothing to review.

const MAX_FILE_BYTES = 10 * 1024 * 1024;

// The three upload slots, in the order they appear in the markup. `column` is
// the verification_requests column each one's storage path is written to.
const SLOTS = [
  { key: 'idFront', inputId: 'vfIdFront', fileStem: 'id_front', column: 'id_front_path' },
  { key: 'idBack', inputId: 'vfIdBack', fileStem: 'id_back', column: 'id_back_path' },
  { key: 'selfie', inputId: 'vfSelfie', fileStem: 'selfie', column: 'selfie_path' },
];

// What each ID type asks for. `needsBack` is the single source of truth for
// whether the reverse-side card exists at all — it drives the card's
// visibility, the submit gate, the upload loop and the id_back_path value, so
// those four can never disagree with each other.
const ID_TYPES = {
  drivers_license: {
    frontTitle: "Driver's License — Front",
    frontHint: 'Tap to upload a photo',
    backTitle: "Driver's License — Back",
    needsBack: true,
  },
  state_id: {
    frontTitle: 'State ID — Front',
    frontHint: 'Tap to upload a photo',
    backTitle: 'State ID — Back',
    needsBack: true,
  },
  passport: {
    frontTitle: 'Passport — Photo Page',
    frontHint: 'The page with your photo and details',
    backTitle: '',
    needsBack: false,
  },
  resident_card: {
    frontTitle: 'Resident Card — Front',
    frontHint: 'Tap to upload a photo',
    backTitle: 'Resident Card — Back',
    needsBack: true,
  },
};

const DEFAULT_HINT = 'Tap to upload a photo';

// The chosen ID type, or null before anything is picked. Reset on every init
// so reopening the view never inherits a previous session's answer.
let selectedIdType = null;

let listeners = [];
function on(el, evt, fn) { if (!el) return; el.addEventListener(evt, fn); listeners.push(() => el.removeEventListener(evt, fn)); }

// Object URLs for the thumbnails. Revoked on cleanup so a long session that
// opens this view repeatedly does not leak the previews.
let objectUrls = [];

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

// •••-••-1234 — the first five digits are masked, the last four stay legible
// so someone can confirm they typed their own number.
function formatSsnMask(raw) {
  const masked = '•'.repeat(Math.min(raw.length, 5)) + raw.slice(5);
  const parts = [masked.slice(0, 3), masked.slice(3, 5), masked.slice(5)].filter(Boolean);
  return parts.join('-');
}

function fileExtension(file) {
  const fromName = /\.([A-Za-z0-9]+)$/.exec(file.name || '');
  if (fromName) return fromName[1].toLowerCase();
  const fromType = String(file.type || '').split('/')[1];
  return fromType ? fromType.toLowerCase() : 'jpg';
}

function formatDate(value) {
  if (!value) return '';
  const ts = new Date(value);
  if (isNaN(ts.getTime())) return '';
  return ts.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

export function init(root, ctx) {
  const { close, supabaseClient, getCurrentUser } = ctx;

  const statusView = root.querySelector('#vfStatusView');
  const formView = root.querySelector('#vfFormView');
  const subline = root.querySelector('#vfSubline');

  const submitBtn = root.querySelector('#vfSubmitBtn');
  const submitLabel = root.querySelector('#vfSubmitLabel');
  const submitSpinner = root.querySelector('#vfSubmitSpinner');
  const submitError = root.querySelector('#vfSubmitError');

  const ssnInput = root.querySelector('#vfSsn');
  const ssnError = root.querySelector('#vfSsnError');
  const postalInput = root.querySelector('#vfPostalCode');
  const postalError = root.querySelector('#vfPostalCodeError');

  const idTypeCards = root.querySelectorAll('.kyc-idtype');
  const idTypeEmpty = root.querySelector('#vfIdTypeEmpty');
  const typeDocs = root.querySelector('#vfTypeDocs');

  // Required text fields, by id. Apt/Unit is deliberately absent.
  const REQUIRED_TEXT_IDS = ['vfFirstName', 'vfLastName', 'vfDob', 'vfAddress1', 'vfCity', 'vfState'];

  // Raw 9 digits behind the mask. The input's value is only ever the masked
  // display; this is what gets submitted.
  let ssnRaw = '';
  // Chosen File objects, keyed by slot key.
  const chosen = {};
  let submitting = false;

  selectedIdType = null;

  on(root.querySelector('[data-action="close"]'), 'click', close);

  function slotContainer(key) {
    return root.querySelector(`.kyc-slot[data-slot="${key}"]`);
  }

  function backIsRequired() {
    return !!selectedIdType && ID_TYPES[selectedIdType].needsBack;
  }

  // The slots this submission actually needs — idBack drops out for a
  // passport, which has no reverse side to photograph.
  function activeSlots() {
    return SLOTS.filter(slot => slot.key !== 'idBack' || backIsRequired());
  }

  // ---------- Form gating ----------
  function requiredTextFilled() {
    return REQUIRED_TEXT_IDS.every(id => {
      const el = root.querySelector('#' + id);
      return el && el.value.trim().length > 0;
    });
  }

  function allDocumentsChosen() {
    return activeSlots().every(slot => !!chosen[slot.key]);
  }

  function formIsComplete() {
    return requiredTextFilled()
      && ssnRaw.length === 9
      && digitsOnly(postalInput.value).length === 5
      && !!selectedIdType
      && allDocumentsChosen();
  }

  function refreshSubmitState() {
    if (submitting) return;
    submitBtn.disabled = !formIsComplete();
    submitBtn.classList.toggle('opacity-60', submitBtn.disabled);
  }

  // ---------- ID type ----------
  // Wipes a document card back to its empty state: no staged file, no green
  // treatment, no stale error.
  function clearSlot(key) {
    const slot = SLOTS.find(item => item.key === key);
    const container = slotContainer(key);
    const input = root.querySelector('#' + slot.inputId);
    if (input) input.value = '';
    delete chosen[key];
    if (!container) return;
    container.querySelector('.kyc-slot-icon').classList.remove('kyc-slot-icon-done');
    const hint = container.querySelector('.kyc-slot-hint');
    hint.classList.remove('kyc-slot-hint-done');
    // applyIdType() overwrites this for whichever cards the new type shows;
    // resetting here is what stops a hidden card holding "Uploaded".
    hint.textContent = DEFAULT_HINT;
    container.querySelector('.kyc-slot-error').classList.add('hidden');
  }

  function setSlotText(key, title, hint) {
    const container = slotContainer(key);
    if (!container) return;
    container.querySelector('.kyc-slot-title').textContent = title;
    container.querySelector('.kyc-slot-hint').textContent = hint;
  }

  // Paints the document section for the current selection: the prompt panel
  // while nothing is picked, otherwise the cards this ID type calls for.
  function applyIdType() {
    const front = slotContainer('idFront');
    const back = slotContainer('idBack');
    const selfie = slotContainer('selfie');
    const spec = selectedIdType ? ID_TYPES[selectedIdType] : null;

    idTypeCards.forEach(card => {
      card.classList.toggle('kyc-idtype-on', card.getAttribute('data-idtype') === selectedIdType);
    });

    if (!spec) {
      idTypeEmpty.classList.remove('hidden');
      typeDocs.classList.remove('vf-typedocs-open');
      front.classList.add('hidden');
      back.classList.add('hidden');
      selfie.classList.add('hidden');
      return;
    }

    idTypeEmpty.classList.add('hidden');
    front.classList.remove('hidden');
    selfie.classList.remove('hidden');

    // Park the uploads immediately beneath the card that asked for them, so
    // "Front" and "Back" can never be read against the wrong ID type.
    const selectedCard = root.querySelector(`.kyc-idtype[data-idtype="${selectedIdType}"]`);
    if (selectedCard) selectedCard.insertAdjacentElement('afterend', typeDocs);
    typeDocs.classList.add('vf-typedocs-open');

    setSlotText('idFront', spec.frontTitle, spec.frontHint);
    if (spec.needsBack) {
      back.classList.remove('hidden');
      setSlotText('idBack', spec.backTitle, DEFAULT_HINT);
    } else {
      back.classList.add('hidden');
    }
  }

  idTypeCards.forEach(card => {
    on(card, 'click', () => {
      const value = card.getAttribute('data-idtype');
      if (value === selectedIdType) return;
      selectedIdType = value;

      // A licence front left staged under a passport label is a mismatched
      // submission that only surfaces at manual review, so both document
      // cards start over. The selfie is the same photo either way, so it
      // survives the switch.
      clearSlot('idFront');
      clearSlot('idBack');

      applyIdType();
      refreshSubmitState();
    });
  });

  // ---------- SSN masking ----------
  // The field shows bullets for digits already entered, so the digits cannot be
  // read back out of `value`. Instead the bullets are counted to know how much
  // of `ssnRaw` is still hidden, and the visible digits are appended to that
  // prefix — which keeps typing, pasting and backspacing all consistent.
  on(ssnInput, 'input', () => {
    const value = ssnInput.value;
    const bulletCount = (value.match(/•/g) || []).length;
    const visible = digitsOnly(value);
    ssnRaw = (ssnRaw.slice(0, bulletCount) + visible).slice(0, 9);
    ssnInput.value = formatSsnMask(ssnRaw);
    const caret = ssnInput.value.length;
    try { ssnInput.setSelectionRange(caret, caret); } catch (err) {}
    ssnError.classList.add('hidden');
    refreshSubmitState();
  });

  on(ssnInput, 'blur', () => {
    if (ssnRaw.length > 0 && ssnRaw.length !== 9) {
      ssnError.textContent = 'Social Security Number must be 9 digits.';
      ssnError.classList.remove('hidden');
    } else {
      ssnError.classList.add('hidden');
    }
  });

  // ---------- ZIP ----------
  on(postalInput, 'input', () => {
    postalInput.value = digitsOnly(postalInput.value).slice(0, 5);
    postalError.classList.add('hidden');
    refreshSubmitState();
  });

  on(postalInput, 'blur', () => {
    const zip = digitsOnly(postalInput.value);
    if (zip.length > 0 && zip.length !== 5) {
      postalError.textContent = 'ZIP code must be 5 digits.';
      postalError.classList.remove('hidden');
    } else {
      postalError.classList.add('hidden');
    }
  });

  REQUIRED_TEXT_IDS.forEach(id => {
    on(root.querySelector('#' + id), 'input', refreshSubmitState);
    on(root.querySelector('#' + id), 'change', refreshSubmitState);
  });

  // ---------- Upload slots ----------
  SLOTS.forEach(slot => {
    const input = root.querySelector('#' + slot.inputId);
    const container = root.querySelector(`.kyc-slot[data-slot="${slot.key}"]`);
    if (!input || !container) return;

    const replaceBtn = container.querySelector('.kyc-slot-replace');
    const slotError = container.querySelector('.kyc-slot-error');
    const icon = container.querySelector('.kyc-slot-icon');
    const hint = container.querySelector('.kyc-slot-hint');

    function showSlotError(message) {
      slotError.textContent = message;
      slotError.classList.remove('hidden');
    }

    // A rejected pick is dropped rather than left staged — otherwise the slot
    // would read as filled while submit stayed blocked.
    function rejectFile(message) {
      input.value = '';
      delete chosen[slot.key];
      icon.classList.remove('kyc-slot-icon-done');
      hint.classList.remove('kyc-slot-hint-done');
      hint.textContent = slot.key === 'idFront' && selectedIdType
        ? ID_TYPES[selectedIdType].frontHint
        : DEFAULT_HINT;
      showSlotError(message);
      refreshSubmitState();
    }

    on(input, 'change', () => {
      const file = input.files && input.files[0];
      slotError.classList.add('hidden');
      if (!file) return;

      if (!String(file.type || '').startsWith('image/')) {
        rejectFile('Please upload a JPG or PNG.');
        return;
      }

      if (file.size > MAX_FILE_BYTES) {
        rejectFile('File must be under 10MB.');
        return;
      }

      chosen[slot.key] = file;
      // The card keeps its layout and turns green, so it stays a tap target
      // for replacing the image.
      icon.classList.add('kyc-slot-icon-done');
      hint.textContent = 'Uploaded';
      hint.classList.add('kyc-slot-hint-done');
      refreshSubmitState();
    });

    on(replaceBtn, 'click', () => { input.click(); });
  });

  // ---------- Status panels ----------
  const PRIMARY_BTN_CLASS = 'w-full h-[50px] rounded-[14px] bg-[#2563EB] text-white text-[15px] font-semibold cursor-pointer hover:opacity-90 transition-all shadow-lg';

  function renderStatusPanel({ heading, body, meta, buttonText, onButton }) {
    formView.classList.add('hidden');
    statusView.classList.remove('hidden');
    // Class hooks rather than positional selectors — the panel's own wrapper is
    // also a div, so a `div > div:nth-child(n)` lookup matches the card itself.
    statusView.innerHTML = `
      <div class="bg-white dark:bg-[#0D1728] border border-transparent dark:border-white/[0.06] rounded-[22px] p-[18px] shadow-lg mb-[20px]">
        <div class="kyc-status-heading text-[17px] font-bold text-[#111827] dark:text-white mb-[6px]"></div>
        <div class="kyc-status-body text-[14px] font-normal text-[#6B7280] dark:text-[#8E9CBA] leading-relaxed"></div>
        <div class="kyc-status-meta hidden text-[13px] font-semibold text-[#111827] dark:text-white mt-[14px]"></div>
      </div>
      <button type="button" class="kyc-status-btn ${PRIMARY_BTN_CLASS}"></button>
    `;
    // textContent, not innerHTML: rejection_reason is operator-entered copy.
    statusView.querySelector('.kyc-status-heading').textContent = heading;
    statusView.querySelector('.kyc-status-body').textContent = body || '';
    const metaEl = statusView.querySelector('.kyc-status-meta');
    if (meta) {
      metaEl.textContent = meta;
      metaEl.classList.remove('hidden');
    }
    const btn = statusView.querySelector('.kyc-status-btn');
    btn.textContent = buttonText;
    on(btn, 'click', onButton);
  }

  function renderForm() {
    statusView.classList.add('hidden');
    statusView.innerHTML = '';
    formView.classList.remove('hidden');
    if (subline) subline.classList.remove('hidden');
    applyIdType();
    refreshSubmitState();
  }

  function renderPending(submittedAt) {
    if (subline) subline.classList.add('hidden');
    const when = formatDate(submittedAt);
    renderStatusPanel({
      heading: "We're reviewing your information",
      body: 'A representative is verifying your documents. This usually takes less than 1 business day.',
      meta: when ? `Submitted ${when}` : '',
      buttonText: 'Back to Accounts',
      onButton: close,
    });
  }

  function renderVerified() {
    if (subline) subline.classList.add('hidden');
    renderStatusPanel({
      heading: 'Your identity is verified',
      body: "You're all set. You can now open new accounts.",
      meta: '',
      buttonText: 'Back to Accounts',
      onButton: close,
    });
  }

  function renderRejected(reason) {
    if (subline) subline.classList.add('hidden');
    renderStatusPanel({
      heading: "We couldn't verify your information",
      body: reason || '',
      meta: '',
      buttonText: 'Resubmit',
      onButton: renderForm,
    });
  }

  // ---------- Submit ----------
  function setSubmitting(isSubmitting) {
    submitting = isSubmitting;
    submitBtn.disabled = isSubmitting;
    submitSpinner.classList.toggle('hidden', !isSubmitting);
    submitLabel.textContent = isSubmitting ? 'Submitting' : 'Submit for Review';
    submitBtn.classList.toggle('opacity-60', isSubmitting);
  }

  function showSubmitError(message) {
    submitError.textContent = message;
    submitError.classList.remove('hidden');
  }

  async function handleSubmit() {
    // A second press cannot land: the guard covers the await gap before the
    // disabled attribute takes effect, and the button stays disabled for the
    // whole upload.
    if (submitting) return;
    submitError.classList.add('hidden');

    if (!formIsComplete()) {
      refreshSubmitState();
      return;
    }

    setSubmitting(true);

    try {
      if (!supabaseClient) throw new Error('You appear to be offline. Please try again.');

      const user = await getCurrentUser();
      if (!user) throw new Error('Your session has expired. Please sign in again.');

      // 1. Documents first. Nothing is written to the database until every
      //    required file is in the bucket, so a half-uploaded set never
      //    becomes a request.
      const paths = {};
      for (const slot of activeSlots()) {
        const file = chosen[slot.key];
        const path = `${user.id}/${slot.fileStem}.${fileExtension(file)}`;
        const { error: uploadError } = await supabaseClient
          .storage
          .from('kyc-documents')
          .upload(path, file, { upsert: true, contentType: file.type || undefined });
        if (uploadError) throw uploadError;
        paths[slot.column] = path;
      }

      // 2. The request row. id_back_path is explicitly null for a passport
      //    rather than absent, so the column says "no reverse side" instead of
      //    "not answered".
      const { error: insertError } = await supabaseClient
        .from('verification_requests')
        .insert({
          user_id: user.id,
          legal_first_name: root.querySelector('#vfFirstName').value.trim(),
          legal_last_name: root.querySelector('#vfLastName').value.trim(),
          date_of_birth: root.querySelector('#vfDob').value,
          ssn: ssnRaw,
          address_line1: root.querySelector('#vfAddress1').value.trim(),
          address_line2: root.querySelector('#vfAddress2').value.trim() || null,
          city: root.querySelector('#vfCity').value.trim(),
          state: root.querySelector('#vfState').value.trim(),
          postal_code: digitsOnly(postalInput.value),
          id_type: selectedIdType,
          id_front_path: paths.id_front_path,
          id_back_path: paths.id_back_path || null,
          selfie_path: paths.selfie_path,
          status: 'pending',
        });
      if (insertError) throw insertError;

      // 3. Only now does the profile move to pending — see the note at the top
      //    of this file for why this cannot run before the insert succeeds.
      const { error: profileError } = await supabaseClient
        .from('profiles')
        .update({ kyc_status: 'pending' })
        .eq('id', user.id);
      if (profileError) throw profileError;

      // 4. Straight into the pending state, in place. The view stays open.
      let submittedAt = null;
      try {
        const { data } = await supabaseClient
          .from('verification_requests')
          .select('submitted_at')
          .eq('user_id', user.id)
          .order('submitted_at', { ascending: false })
          .limit(1);
        if (data && data.length) submittedAt = data[0].submitted_at;
      } catch (err) {
        console.error('Verification submitted_at read error:', err);
      }
      setSubmitting(false);
      renderPending(submittedAt || new Date().toISOString());
    } catch (err) {
      console.error('Verification submit error:', err);
      setSubmitting(false);
      refreshSubmitState();
      showSubmitError(err && err.message ? err.message : 'Something went wrong. Please try again.');
    }
  }

  on(submitBtn, 'click', handleSubmit);

  // ---------- Initial state ----------
  async function resolveState() {
    if (!supabaseClient) return { status: null, reason: '', submittedAt: null };

    const user = await getCurrentUser();
    if (!user) return { status: null, reason: '', submittedAt: null };

    const { data: profile, error } = await supabaseClient
      .from('profiles')
      .select('kyc_status, rejection_reason')
      .eq('id', user.id)
      .maybeSingle();
    if (error) throw error;

    const status = profile ? profile.kyc_status : null;
    let submittedAt = null;

    if (status === 'pending') {
      const { data } = await supabaseClient
        .from('verification_requests')
        .select('submitted_at')
        .eq('user_id', user.id)
        .order('submitted_at', { ascending: false })
        .limit(1);
      if (data && data.length) submittedAt = data[0].submitted_at;
    }

    return { status, reason: profile ? profile.rejection_reason : '', submittedAt };
  }

  applyIdType();

  (async () => {
    let state = { status: null, reason: '', submittedAt: null };
    try {
      state = await resolveState();
    } catch (err) {
      console.error('Verification state error:', err);
    }

    if (state.status === 'pending') renderPending(state.submittedAt);
    else if (state.status === 'verified') renderVerified();
    else if (state.status === 'rejected') renderRejected(state.reason);
    else renderForm();
  })();
}

export function cleanup() {
  listeners.forEach(off => off());
  listeners = [];
  objectUrls.forEach(url => { try { URL.revokeObjectURL(url); } catch (err) {} });
  objectUrls = [];
}
