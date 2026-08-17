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

/* === "CHOOSE WHAT'S RIGHT FOR YOU" CAROUSEL — APPENDED ===
   The swipe belongs to the browser: the track is a scroll-snap container, so
   dragging works on touch without script. What is left is the arrows and dots,
   which exist because a mouse has no swipe — and the decision not to show them
   at all when every link already fits. */
(function () {
  var track = document.getElementById('qlTrack');
  var nav = document.getElementById('qlNav');
  var dotsEl = document.getElementById('qlDots');
  var prev = document.getElementById('qlPrev');
  var next = document.getElementById('qlNext');
  if (!track || !nav || !dotsEl || !prev || !next) return;

  var pages = 1;

  function items() {
    return track.querySelectorAll('.quick-link-item');
  }

  /* Measured off the items and how many fit, not off scrollWidth / clientWidth:
     the track carries padding, which inflates scrollWidth and would report a
     page that does not exist. */
  function measure() {
    var it = items();
    if (!it.length) { pages = 1; return; }
    var a = it[0].getBoundingClientRect();
    var step = it.length > 1 ? it[1].getBoundingClientRect().left - a.left : a.width;
    var perView = Math.max(1, Math.round(track.clientWidth / step));
    pages = Math.max(1, Math.ceil(it.length / perView));
  }

  function maxScroll() {
    return Math.max(0, track.scrollWidth - track.clientWidth);
  }

  /* Read as a fraction of the distance actually scrollable. The last page is
     usually a partial one — the track clamps before the final item reaches the
     left edge — and an index-based reading would sit on the wrong dot there. */
  function currentPage() {
    var m = maxScroll();
    if (m <= 0 || pages < 2) return 0;
    return Math.min(pages - 1, Math.max(0, Math.round((track.scrollLeft / m) * (pages - 1))));
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
        b.className = 'ql-dot';
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-label', 'Page ' + (i + 1) + ' of ' + pages);
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
})();
