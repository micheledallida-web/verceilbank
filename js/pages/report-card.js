// Report a Card — Support > Report Lost or Stolen Card.
//
// Two outcomes, and the difference between them matters more than anything
// else on the screen: locking a card is reversible, closing it is not. So the
// permanent action confirms before it runs, and the reversible one does not.

// What each replacement choice actually means for the person waiting for a
// card. Shown under the field rather than left for them to guess.
const REPLACEMENT_HINTS = {
  'Standard Delivery': 'Arrives in 5–7 business days. No fee.',
  'Expedited Delivery': 'Arrives in 1–2 business days. No fee.',
  'Temporary Digital Card': 'Available in your wallet within minutes, with the physical card to follow.',
};

let listeners = [];
function on(el, evt, fn) { if (!el) return; el.addEventListener(evt, fn); listeners.push(() => el.removeEventListener(evt, fn)); }

export function init(root, ctx) {
  const { supabaseClient, getCurrentUser, genRef, showModal, close } = ctx;

  const reportCardError = root.querySelector('#reportCardError');
  const replacementSelect = root.querySelector('#reportReplacement');
  const replacementHint = root.querySelector('#reportReplacementHint');
  const lockBtn = root.querySelector('#lockNowBtn');
  const closeCardBtn = root.querySelector('#blockPermanentBtn');

  function renderReplacementHint() {
    replacementHint.textContent = REPLACEMENT_HINTS[replacementSelect.value] || '';
  }
  renderReplacementHint();
  on(replacementSelect, 'change', renderReplacementHint);

  function setBusy(button, busyLabel) {
    const title = button.querySelector('.rc-btn-t');
    const original = title.textContent;
    lockBtn.disabled = true;
    closeCardBtn.disabled = true;
    title.textContent = busyLabel;
    return () => {
      title.textContent = original;
      lockBtn.disabled = false;
      closeCardBtn.disabled = false;
    };
  }

  async function submitCardReport(permanent, button) {
    reportCardError.classList.add('hidden');
    const done = setBusy(button, permanent ? 'Closing card...' : 'Locking card...');

    try {
      if (!supabaseClient) throw new Error('Supabase client not available');
      const user = await getCurrentUser();
      if (!user) throw new Error('Not signed in');
      const ref = genRef();
      const replacement = replacementSelect.value;

      const { error } = await supabaseClient.from('card_reports').insert({
        user_id: user.id,
        card_type: root.querySelector('#reportCardType').value,
        reason: root.querySelector('#reportReason').value,
        replacement_option: replacement,
        permanent_block: permanent,
        status: 'blocked',
        reference_number: ref,
      });
      if (error) throw error;

      ctx.recordEvent(permanent ? 'card.closed' : 'card.locked', {
        card_type: root.querySelector('#reportCardType').value,
        reason: root.querySelector('#reportReason').value,
        replacement,
        reference: ref,
      });

      close();
      showModal(
        permanent ? 'Card closed' : 'Card locked',
        permanent
          ? `Your card is closed and a replacement is on its way — ${replacement.toLowerCase()}. Reference ${ref}.`
          : `No new charges can be made on this card. Contact support to unlock it if it turns up. Reference ${ref}.`,
      );
    } catch (e) {
      console.error('Card report error:', e);
      done();
      reportCardError.textContent = "We couldn't file this report just now. Please try again, or call the number on the back of your card.";
      reportCardError.classList.remove('hidden');
    }
  }

  on(root.querySelector('[data-action="close"]'), 'click', close);
  on(lockBtn, 'click', () => submitCardReport(false, lockBtn));

  // The only irreversible thing on the screen asks first.
  on(closeCardBtn, 'click', () => {
    showModal(
      'Close this card for good?',
      'The card and its number stop working permanently and a replacement is issued. If you only want to stop charges for now, lock the card instead.',
      { label: 'Close card', run: () => submitCardReport(true, closeCardBtn) },
    );
  });
}

export function cleanup() {
  listeners.forEach(off => off());
  listeners = [];
}
