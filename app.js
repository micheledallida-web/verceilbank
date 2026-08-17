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

  initHeroRotator();
});

// --------------------------------------------------------------------------
// VERCEL-STYLE HIGHLIGHT WORD ROTATOR ANIMATION
// --------------------------------------------------------------------------
// A function rather than inline setup, and it clears its own timer first,
// because the word it rotates lives inside the swapped container: navigating
// away and back builds a new one, and the interval left running against the
// old node would still be there, ticking at a element no longer on the page.
var heroRotatorTimer = null;

function initHeroRotator() {
  clearInterval(heroRotatorTimer);
  heroRotatorTimer = null;

  var words = ["simple.", "secure.", "seamless.", "effortless."];
  var currentIndex = 0;
  var wordElement = document.getElementById("rotatingWord");
  if (!wordElement) return;

  heroRotatorTimer = setInterval(function () {
    // 1. Animate current highlight word up and out
    wordElement.classList.add("swap-out");

    setTimeout(function () {
      // 2. Advance index and change text
      currentIndex = (currentIndex + 1) % words.length;
      wordElement.textContent = words[currentIndex];

      // 3. Move instantly to bottom start position
      wordElement.classList.remove("swap-out");
      wordElement.classList.add("swap-prepare");

      // 4. Smoothly animate up into center position
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          wordElement.classList.remove("swap-prepare");
        });
      });
    }, 450); // Matches CSS transition duration
  }, 2800); // Rotates every 2.8 seconds
}

/* === "CHOOSE WHAT'S RIGHT FOR YOU" CAROUSEL — APPENDED ===
   The swipe belongs to the browser: the track is a scroll-snap container, so
   dragging works on touch without script. What is left is the arrows and dots,
   which exist because a mouse has no swipe — and the decision not to show them
   at all when every link already fits.

   Everything it binds hangs off one AbortController, and the strip lives inside
   the swapped container: a soft navigation away and back builds a new strip, so
   the run before it has to be taken down whole — its timer stopped, its
   observer disconnected, every listener dropped — or each visit would leave
   another set behind, all of them still firing at nodes off the page. */
var stripTeardown = null;

function initCategoryStrip() {
  if (stripTeardown) { stripTeardown(); stripTeardown = null; }

  var track = document.getElementById('qlTrack');
  var nav = document.getElementById('qlNav');
  var dotsEl = document.getElementById('qlDots');
  var prev = document.getElementById('qlPrev');
  var next = document.getElementById('qlNext');
  if (!track || !nav || !dotsEl || !prev || !next) return;

  var abort = new AbortController();
  var signal = abort.signal;
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
    // A resize can turn one page into three or three into one, so the timer is
    // re-decided from the new count every time this runs. Hoisting is what lets
    // it call forward to schedule(), which is declared below.
    schedule();
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

  prev.addEventListener('click', function () { goTo(currentPage() - 1); }, { signal: signal });
  next.addEventListener('click', function () { goTo(currentPage() + 1); }, { signal: signal });

  track.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') { e.preventDefault(); goTo(currentPage() + 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(currentPage() - 1); }
  }, { signal: signal });

  var tick;
  track.addEventListener('scroll', function () {
    clearTimeout(tick);
    tick = setTimeout(syncState, 60);
  }, { passive: true, signal: signal });

  var rz;
  window.addEventListener('resize', function () {
    clearTimeout(rz);
    rz = setTimeout(build, 150);
  }, { signal: signal });

  /* ---- the carousel moves on its own ----
     Out to the last page and back to the first, over and over, the way a bank's
     category strip does. Back rather than a jump to the start: the jump reads
     as a glitch at this size, where the whole strip is on screen at once and
     the eye follows the movement rather than the position.

     It yields to the customer in every case where it would otherwise be in the
     way. A pointer over the strip, a finger on it, keyboard focus inside it, an
     arrow or a dot pressed — the timer stops, and after a pointer leaves it
     waits a beat longer than usual before picking up again, so it does not slide
     out from under someone who is still reading. It does not run while the tab
     is in the background or while the strip is scrolled off the screen, and it
     does not run at all for anyone who has asked the system to reduce motion. */
  var STEP_MS = 4200;
  var RESUME_MS = 6000;
  var timer = null;
  var direction = 1;
  var held = false;      // pointer, touch or focus is on the strip
  var onScreen = true;
  var stillMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function canRun() {
    return pages > 1 && !held && onScreen && !document.hidden && !stillMotion.matches;
  }

  function stop() {
    clearTimeout(timer);
    timer = null;
  }

  function schedule(delay) {
    stop();
    if (!canRun()) return;
    timer = setTimeout(step, delay == null ? STEP_MS : delay);
  }

  function step() {
    if (!canRun()) { stop(); return; }
    var i = currentPage();
    // Turn round at either end rather than wrapping.
    if (i >= pages - 1) direction = -1;
    else if (i <= 0) direction = 1;
    goTo(i + direction);
    schedule();
  }

  function hold() { held = true; stop(); }
  function release(delay) {
    held = false;
    schedule(delay);
  }

  ['pointerenter', 'focusin'].forEach(function (evt) {
    track.addEventListener(evt, hold, { signal: signal });
    nav.addEventListener(evt, hold, { signal: signal });
  });
  ['pointerleave', 'focusout'].forEach(function (evt) {
    track.addEventListener(evt, function () { release(RESUME_MS); }, { signal: signal });
    nav.addEventListener(evt, function () { release(RESUME_MS); }, { signal: signal });
  });

  // A drag is the one interaction that never fires pointerleave on the way out.
  track.addEventListener('touchstart', hold, { passive: true, signal: signal });
  track.addEventListener('touchend', function () { release(RESUME_MS); }, { passive: true, signal: signal });

  // Pressing an arrow or a dot is a destination, not a pause: honour it, then
  // carry on from there.
  nav.addEventListener('click', function () { release(RESUME_MS); }, { signal: signal });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else schedule();
  }, { signal: signal });

  var watcher = null;
  if (typeof IntersectionObserver === 'function') {
    watcher = new IntersectionObserver(function (entries) {
      onScreen = entries[0].isIntersecting;
      if (onScreen) schedule();
      else stop();
    }, { threshold: 0.25 });
    watcher.observe(track);
  }

  // Safari before 14 has addListener only.
  if (stillMotion.addEventListener) {
    stillMotion.addEventListener('change', function () { schedule(); }, { signal: signal });
  }

  stripTeardown = function () {
    stop();
    abort.abort();
    if (watcher) watcher.disconnect();
  };

  build();
  schedule();
}

/* === HOVER SPOTLIGHT — APPENDED ===
   Hands the cursor's position to the stylesheet and does nothing else. Two
   custom properties on the card under the pointer — --mouse-x and --mouse-y,
   its offset within that card — and index.css owns the colour, the size, the
   shape and the fade.

   One delegated listener on the document rather than a pair on every card:
   cards come and go with a soft navigation, and a delegated listener does not
   care. One write per animation frame rather than one per event, because a
   mouse reports far more often than the screen redraws and the frames in
   between are discarded anyway. */
(function () {
  if (!window.matchMedia || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  var CARDS = '.promo-card, .quick-link-item';
  var frame = null;
  var card = null;
  var pageX = 0;
  var pageY = 0;

  function paint() {
    frame = null;
    var rect = card.getBoundingClientRect();
    card.style.setProperty('--mouse-x', (pageX - rect.left) + 'px');
    card.style.setProperty('--mouse-y', (pageY - rect.top) + 'px');
  }

  document.addEventListener('mousemove', function (e) {
    var hit = e.target && e.target.closest ? e.target.closest(CARDS) : null;
    if (!hit) return;

    card = hit;
    pageX = e.clientX;
    pageY = e.clientY;
    if (!frame) frame = requestAnimationFrame(paint);
  }, { passive: true });
})();

/* === CLIENT-SIDE NAVIGATION — APPENDED ===
   Following a link fetches the next page and swaps it into #swap-root instead
   of reloading the browser: the header, the stylesheets and the fonts stay
   where they are, so a move between two pages of the same site costs one
   document rather than a fresh start.

   What gets swapped is the container, the page's title and its own <style>
   block — the marketing pages each carry one, and leaving the last page's
   behind would style the new page with the old page's rules.

   It fails open, always. A cross-origin link, a download, a new tab, a
   modified click, an anchor on the page, anything the app owns rather than the
   marketing site, a request that does not come back, a reply that is not HTML,
   a page with no container of its own — every one of them falls through to an
   ordinary navigation. Nothing here is load-bearing: with the script removed
   the links are still links. */
(function () {
  var ROOT_ID = 'swap-root';
  var root = document.getElementById(ROOT_ID);
  if (!root || !window.history || !window.history.pushState || !window.fetch) return;

  // Screens belonging to the signed-in app: a different shell, a different
  // stylesheet and a session to establish. They are entered, not swapped into.
  var APP_PATHS = /(^|\/)(signin|signup|reset-password|dashboard)\.html$|(^|\/)pages\//;

  var cache = Object.create(null);
  var current = location.href;

  history.scrollRestoration = 'manual';
  history.replaceState({ soft: true, y: 0 }, '', location.href);

  function samePage(a, b) {
    return a.split('#')[0] === b.split('#')[0];
  }

  function swappable(link, e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
    if (!link || !link.href || link.target || link.hasAttribute('download')) return false;
    if (link.origin !== location.origin) return false;
    if (link.protocol !== 'http:' && link.protocol !== 'https:') return false;
    if (APP_PATHS.test(link.pathname)) return false;
    // An anchor on the page we are already on is the browser's job.
    if (samePage(link.href, location.href)) return false;
    return true;
  }

  function apply(doc, url) {
    var next = doc.getElementById(ROOT_ID);
    if (!next) return false;

    root.innerHTML = next.innerHTML;
    document.title = doc.title;

    // The page's own <style>, swapped with it. Marked in the markup rather
    // than guessed at, so a shared block could be added later without this
    // carrying it off.
    var mine = document.head.querySelectorAll('style[data-page-style]');
    for (var i = 0; i < mine.length; i++) mine[i].remove();
    var theirs = doc.head.querySelectorAll('style[data-page-style]');
    for (var j = 0; j < theirs.length; j++) {
      document.head.appendChild(document.importNode(theirs[j], true));
    }

    var canonical = document.querySelector('link[rel="canonical"]');
    var next_canonical = doc.querySelector('link[rel="canonical"]');
    if (canonical && next_canonical) canonical.href = next_canonical.href;

    current = url;
    // Everything inside the container is new, so anything that had wired
    // itself to the old nodes wires itself again.
    document.dispatchEvent(new CustomEvent('vb:navigated', { detail: { url: url } }));
    return true;
  }

  function load(url) {
    if (cache[url]) return Promise.resolve(cache[url]);
    return fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'soft-nav' } })
      .then(function (res) {
        if (!res.ok) throw new Error(res.status);
        var type = res.headers.get('content-type') || '';
        if (type.indexOf('text/html') === -1) throw new Error('not html');
        return res.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        cache[url] = doc;
        return doc;
      });
  }

  function go(url, push, restoreY) {
    load(url).then(function (doc) {
      if (!apply(doc, url)) { location.href = url; return; }
      if (push) history.pushState({ soft: true, y: 0 }, '', url);
      var hash = url.indexOf('#') > -1 ? url.slice(url.indexOf('#') + 1) : '';
      var target = hash ? document.getElementById(hash) : null;
      if (target) target.scrollIntoView();
      else window.scrollTo(0, restoreY || 0);
    })
    .catch(function () { location.href = url; });
  }

  document.addEventListener('click', function (e) {
    var link = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!swappable(link, e)) return;

    e.preventDefault();
    // Where the reader was on this page, so the back button can put them back.
    history.replaceState({ soft: true, y: window.scrollY }, '', current);
    go(link.href, true, 0);
  });

  window.addEventListener('popstate', function (e) {
    if (!e.state || !e.state.soft) return;   // not a page this script pushed
    go(location.href, false, e.state.y || 0);
  });
})();

/* First run, now that the carousel is a function rather than an IIFE. */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCategoryStrip);
} else {
  initCategoryStrip();
}

/* The pieces that live inside the swapped container, wired again to the nodes
   that replaced theirs. The mobile menu is not among them: it belongs to the
   header, which never moves. */
document.addEventListener('vb:navigated', function () {
  initHeroRotator();
  initCategoryStrip();
});
