// Footer accordion — the link groups that open and close on a phone.
//
// A plain script rather than a module, because it is shared by two pages that
// load their JavaScript differently: the marketing site has no module graph at
// all, and the app's is behind a signed-in session. This needs neither.
//
// It began inline at the foot of index.html. The dashboard grew the same
// footer, and two copies of the same handler is how the two footers start
// behaving differently — so there is one copy, and both pages load it.
(function () {
  'use strict';

  // One listener on the document rather than one per heading, and it is not
  // only about the count. The marketing site swaps its content in place (see
  // the soft navigation in app.js), so the footer a customer clicks may be a
  // set of nodes that did not exist when this script ran. Delegation does not
  // care: it matches the heading at the moment of the click, whenever the
  // heading arrived, and there is no re-wiring step to remember.
  document.addEventListener('click', function (event) {
    var header = event.target.closest && event.target.closest('.footer-section-header');
    if (!header) return;

    header.classList.toggle('active');

    var panel = header.nextElementSibling;
    if (!panel) return;

    // Read the inline value this script wrote last time rather than the
    // computed one: from 1024px up the stylesheet forces every panel open, so a
    // computed check would report "open" for a panel nobody has touched and the
    // first tap after narrowing the window would close it.
    panel.style.display = panel.style.display === 'flex' ? 'none' : 'flex';
  });
})();
