document.addEventListener('DOMContentLoaded', () => {
  const menuBtn = document.getElementById('mobileMenuToggle');
  const closeBtn = document.getElementById('closeDrawerBtn');
  const navLinks = document.getElementById('navLinks');
  
  let backdrop = document.getElementById('menuBackdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.className = 'menu-backdrop';
    backdrop.id = 'menuBackdrop';
    document.body.appendChild(backdrop);
  }

  function openMenu() {
    navLinks.classList.add('active');
    backdrop.classList.add('active');
    document.body.style.overflow = 'hidden'; 
  }

  function closeMenu() {
    navLinks.classList.remove('active');
    backdrop.classList.remove('active');
    document.body.style.overflow = '';
  }

  if (menuBtn) menuBtn.addEventListener('click', openMenu);
  if (closeBtn) closeBtn.addEventListener('click', closeMenu);
  if (backdrop) backdrop.addEventListener('click', closeMenu);
  
  document.querySelectorAll('.drawer-items .nav-link').forEach(link => {
    link.addEventListener('click', closeMenu);
  });

  // --------------------------------------------------------------------------
  // VERCEL-STYLE HIGHLIGHT WORD ROTATOR ANIMATION
  // --------------------------------------------------------------------------
  const words = ["simple.", "secure.", "seamless.", "effortless."];
  let currentIndex = 0;
  const wordElement = document.getElementById("rotatingWord");

  if (wordElement) {
    setInterval(() => {
      // 1. Animate current highlight word up and out
      wordElement.classList.add("swap-out");

      setTimeout(() => {
        // 2. Advance index and change text
        currentIndex = (currentIndex + 1) % words.length;
        wordElement.textContent = words[currentIndex];

        // 3. Move instantly to bottom start position
        wordElement.classList.remove("swap-out");
        wordElement.classList.add("swap-prepare");

        // 4. Smoothly animate up into center position
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            wordElement.classList.remove("swap-prepare");
          });
        });
      }, 450); // Matches CSS transition duration
    }, 2800); // Rotates every 2.8 seconds
  }
});

/* === OFFER CAROUSEL — APPENDED ===
   The swipe is the browser's: the track is an overflow-x scroll-snap
   container, so dragging works on touch with no JavaScript involved. What is
   left for script is the part a mouse has no gesture for — arrows and dots —
   plus deciding whether to show them at all, since on a wide screen every card
   can already be visible and a control that pages nothing is worse than none. */
(function () {
  var track = document.getElementById('promoTrack');
  var nav = document.getElementById('promoNav');
  var dotsEl = document.getElementById('promoDots');
  var prev = document.getElementById('promoPrev');
  var next = document.getElementById('promoNext');
  if (!track || !nav || !dotsEl || !prev || !next) return;

  var pages = 1;
  var perView = 1;

  function slides() {
    return track.querySelectorAll('.promo-section');
  }

  /* Measured off the slides rather than off scrollWidth/clientWidth: the track
     carries horizontal padding, which inflates scrollWidth and had the ratio
     reporting a single page on a laptop while a fourth card sat off-screen. */
  function measure() {
    var s = slides();
    if (!s.length) { perView = 1; pages = 1; return; }
    var a = s[0].getBoundingClientRect();
    var step = s.length > 1
      ? s[1].getBoundingClientRect().left - a.left
      : a.width;
    perView = Math.max(1, Math.round(track.clientWidth / step));
    pages = Math.max(1, Math.ceil(s.length / perView));
  }

  function maxScroll() {
    return Math.max(0, track.scrollWidth - track.clientWidth);
  }

  /* Page position is read as a fraction of the scrollable distance rather than
     as "slide index / perView". With four cards three to a view the last page
     is a partial one: scrolling to the fourth card clamps at the end of the
     track, so the slide-index reading stayed on page one and the dot never
     moved off the first. A fraction cannot disagree with where the track has
     actually come to rest. */
  function currentPage() {
    var m = maxScroll();
    if (m <= 0 || pages < 2) return 0;
    return Math.min(pages - 1, Math.max(0,
      Math.round((track.scrollLeft / m) * (pages - 1))));
  }

  function goTo(i) {
    if (pages < 2) return;
    i = Math.min(pages - 1, Math.max(0, i));
    track.scrollTo({ left: (i / (pages - 1)) * maxScroll(), behavior: 'smooth' });
  }

  function syncState() {
    var i = currentPage();
    var dots = dotsEl.children;
    for (var d = 0; d < dots.length; d++) {
      dots[d].setAttribute('aria-selected', d === i ? 'true' : 'false');
    }
    prev.disabled = i <= 0;
    next.disabled = i >= pages - 1;
  }

  function build() {
    measure();
    nav.hidden = pages < 2;
    if (nav.hidden) return;

    if (dotsEl.children.length !== pages) {
      dotsEl.innerHTML = '';
      for (var i = 0; i < pages; i++) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'promo-dot';
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-label', 'Offers, page ' + (i + 1) + ' of ' + pages);
        b.addEventListener('click', (function (n) {
          return function () { goTo(n); };
        })(i));
        dotsEl.appendChild(b);
      }
    }
    syncState();
  }

  prev.addEventListener('click', function () { goTo(currentPage() - 1); });
  next.addEventListener('click', function () { goTo(currentPage() + 1); });

  // Keyboard, for the track itself — it is focusable, so it has to answer.
  track.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') { e.preventDefault(); goTo(currentPage() + 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(currentPage() - 1); }
  });

  var tick;
  track.addEventListener('scroll', function () {
    clearTimeout(tick);
    tick = setTimeout(syncState, 60);
  }, { passive: true });

  var rz;
  window.addEventListener('resize', function () {
    clearTimeout(rz);
    rz = setTimeout(build, 150);
  });

  build();
  // The card heights settle once the article's photo has loaded, and the page
  // count is measured off them.
  window.addEventListener('load', build);
})();
