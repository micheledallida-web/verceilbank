// Live-ticking sparkline for the dashboard's Investments card.
//
// Unlike the portfolio chart (js/shared/portfolio-chart.js), which nudges its
// last point every few seconds, this one actually scrolls: the series advances
// by a fractional index on every animation frame, so the line glides leftward
// continuously the way a real-time market feed does, instead of stepping.
//
// No chart library — plain SVG path rebuilding on requestAnimationFrame, in
// keeping with the rest of this codebase.

const VIEW_W = 380;
const VIEW_H = 48;
const PAD_Y = 7;
const POINTS = 44;      // visible samples across the card
const TICK_MS = 1500;   // time for one sample to travel one slot leftward
const DOT_INSET = 5;    // keeps the leading dot clear of the viewport edge

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Values live in a normalised 0..1 band. The walk mean-reverts toward the
// middle so it wanders without ever pinning to the top or bottom edge.
function nextValue(prev, rand, volatility) {
  const drift = (rand() - 0.5) * volatility;
  const reversion = (0.5 - prev) * 0.06;
  return Math.min(0.92, Math.max(0.08, prev + drift + reversion));
}

function xAt(i, phase) {
  return ((i - phase) / (POINTS - 1)) * VIEW_W;
}

function yAt(v) {
  return PAD_Y + (1 - v) * (VIEW_H - PAD_Y * 2);
}

// Smooth the polyline through quadratic midpoints. Straight segments read as
// jagged at 48px tall; this is what gives it the soft premium curve.
function buildPath(values, phase) {
  const pts = values.map((v, i) => [xAt(i, phase), yAt(v)]);
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [cx, cy] = pts[i];
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q${cx.toFixed(2)} ${cy.toFixed(2)} ${mx.toFixed(2)} ${my.toFixed(2)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${last[0].toFixed(2)} ${last[1].toFixed(2)}`;
  return { d, first: pts[0], last };
}

// Height of the curve at an arbitrary x, so the leading dot sits exactly on
// the line rather than on the nearest sample. Inverts xAt().
function valueAtX(values, phase, x) {
  const exact = phase + (x / VIEW_W) * (POINTS - 1);
  const i = Math.floor(exact);
  const t = exact - i;
  const a = values[Math.min(i, values.length - 1)];
  const b = values[Math.min(i + 1, values.length - 1)];
  return a + (b - a) * t;
}

/**
 * Mounts a continuously scrolling sparkline.
 * @param {Object} opts
 * @param {SVGPathElement} opts.line - stroked path
 * @param {SVGPathElement} [opts.fill] - filled area under the line
 * @param {SVGCircleElement} [opts.dot] - leading-edge dot
 * @param {Element} [opts.container] - observed for visibility; defaults to line
 * @param {number} [opts.seed]
 * @param {number} [opts.volatility]
 * @returns {{ destroy: () => void }}
 */
export function createLiveSparkline(opts) {
  // 0.24 gives a lively line that still stays clear of the 0.08/0.92 clamps;
  // much above that and the walk flat-tops against them.
  const { line, fill, dot, seed = 7, volatility = 0.24 } = opts;
  if (!line) return { destroy() {} };
  const container = opts.container || line;

  const rand = mulberry32(seed);
  const values = [];
  let v = 0.42;
  // One extra sample beyond the visible window, waiting off the right edge.
  for (let i = 0; i < POINTS + 1; i++) {
    v = nextValue(v, rand, volatility);
    values.push(v);
  }

  let phase = 0;
  let frame = null;
  let lastTs = 0;
  let running = false;
  let destroyed = false;

  function render() {
    const { d, first, last } = buildPath(values, phase);
    line.setAttribute('d', d);
    if (fill) {
      fill.setAttribute('d', `${d} L${last[0].toFixed(2)} ${VIEW_H} L${first[0].toFixed(2)} ${VIEW_H} Z`);
    }
    if (dot) {
      // Inset by the dot's radius so the SVG viewport doesn't clip it in half.
      const dotX = VIEW_W - DOT_INSET;
      dot.setAttribute('cx', dotX.toFixed(2));
      dot.setAttribute('cy', yAt(valueAtX(values, phase, dotX)).toFixed(2));
    }
  }

  function tick(ts) {
    if (destroyed) return;
    if (!lastTs) lastTs = ts;
    const dt = Math.min(ts - lastTs, 100); // clamp so a backgrounded tab doesn't lurch
    lastTs = ts;

    phase += dt / TICK_MS;
    while (phase >= 1) {
      phase -= 1;
      values.shift();
      values.push(nextValue(values[values.length - 1], rand, volatility));
    }

    render();
    frame = requestAnimationFrame(tick);
  }

  function start() {
    if (running || destroyed) return;
    running = true;
    lastTs = 0;
    frame = requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    if (frame) cancelAnimationFrame(frame);
    frame = null;
  }

  render();

  // Someone who has asked the OS for less motion gets the shape, not the
  // movement.
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduceMotion && reduceMotion.matches) {
    return { destroy() { destroyed = true; } };
  }

  let onScreen = false;
  // Declared before anything that reads them. Both onVisibility and the
  // observer below do, and relying on callback timing for that is how a
  // temporal-dead-zone crash gets introduced by a later edit.
  let scrolling = false;
  let idleTimer = null;

  // Don't burn frames on a hidden tab or a card scrolled out of view.
  // Returning to the tab does NOT start it unconditionally: the card may be
  // scrolled away, in which case starting here would burn frames on something
  // nobody can see and undo what the observer decided.
  function onVisibility() {
    if (document.hidden) stop();
    else if (onScreen && !scrolling) start();
  }
  document.addEventListener('visibilitychange', onVisibility);

  let observer = null;
  if (window.IntersectionObserver) {
    observer = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        onScreen = e.isIntersecting;
        if (onScreen && !document.hidden && !scrolling) start(); else stop();
      });
    }, { threshold: 0 });
    observer.observe(container);
  } else {
    onScreen = true;
    start();
  }

  // ---------- Never compete with a scroll ----------
  //
  // This loop rebuilds an SVG path on every frame, and it lives on the card
  // directly below Interest Checking. So scrolling up from the bottom of the
  // dashboard brought this card into view, the observer above started the
  // loop, and the first frames of that scroll were spent rebuilding a path
  // instead of moving the page. That is the hitch — always in the same place,
  // always on the first attempt, gone on the second because by then the loop
  // was already running.
  //
  // Scrolling wins. The animation stops the moment the page moves and starts
  // again once it has been still for a moment, so the two never share a frame.
  // Nobody watches a sparkline while they are scrolling past it.
  function onScroll() {
    if (!scrolling) {
      scrolling = true;
      stop();
    }
    if (idleTimer) clearTimeout(idleTimer);
    // Long enough to cover the tail of a momentum scroll on iOS, short enough
    // that the chart is moving again before anyone looks at it.
    idleTimer = setTimeout(() => {
      scrolling = false;
      idleTimer = null;
      if (onScreen && !document.hidden) start();
    }, 180);
  }

  window.addEventListener('scroll', onScroll, { passive: true });

  return {
    destroy() {
      destroyed = true;
      stop();
      if (idleTimer) clearTimeout(idleTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('scroll', onScroll);
      if (observer) observer.disconnect();
    },
  };
}
