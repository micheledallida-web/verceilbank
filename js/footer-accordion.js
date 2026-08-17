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

  function wire() {
    var headers = document.querySelectorAll('.footer-section-header');

    Array.prototype.forEach.call(headers, function (header) {
      header.addEventListener('click', function () {
        header.classList.toggle('active');

        var panel = header.nextElementSibling;
        if (!panel) return;

        // Read the inline value this script wrote last time rather than the
        // computed one: from 1024px up the stylesheet forces every panel open,
        // so a computed check would report "open" for a panel nobody has
        // touched and the first tap after narrowing the window would close it.
        panel.style.display = panel.style.display === 'flex' ? 'none' : 'flex';
      });
    });
  }

  // Runs whether the tag is deferred, at the end of the body, or dropped in
  // the head by a page that does it differently later.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
