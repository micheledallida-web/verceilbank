// Turning a Supabase auth failure into something a customer can act on, and
// something the operator can debug.
//
// Loaded as a plain script (not a module) because the three auth screens —
// sign-in, sign-up, reset-password — are plain pages that run inline script.
// It must load after js/config.js and before those inline blocks.
//
// WHY THIS EXISTS
//
// Both auth screens used to collapse every possible failure into one sentence.
// Sign-in said "Invalid login credentials." no matter what had happened, and
// sign-up rewrote anything whose message merely contained the word "invalid"
// into "Invalid registration details or email already in use." So all of these
// looked identical to the person in front of the screen:
//
//   • the project is paused, or the URL is wrong, and nothing was reached
//   • the anon key is wrong, and the server refused the request outright
//   • the address already has an account
//   • email confirmation is on, so there is a link waiting in an inbox
//   • sign-ups are switched off in the project
//   • the password really was mistyped
//
// Only the last of those is the customer's mistake, and it was the only one
// they were ever told about. Worse, the two failures an operator most needs to
// see — unreachable and misconfigured — were the two most thoroughly disguised.
//
// Nothing here changes what the server decides. It changes what is said about
// it, and the original error always goes to the console underneath.

(function () {
  'use strict';

  // Long enough for a cold serverless start on a slow phone connection, short
  // enough that nobody sits watching "Creating account..." wondering whether
  // it is doing anything. A request with no answer and no end is the single
  // worst thing an auth form can do, and it was what this one did.
  var AUTH_TIMEOUT_MS = 20000;

  function timeoutError(label) {
    var err = new Error((label || 'The request') + ' timed out after ' + (AUTH_TIMEOUT_MS / 1000) + 's');
    err.__kind = 'timeout';
    return err;
  }

  // supabase-js returns { data, error } rather than throwing, so this wraps the
  // promise itself. The losing side of the race is abandoned rather than
  // cancelled — supabase-js exposes no abort signal — but the form is already
  // released by then, so a late answer changes nothing.
  function withTimeout(promise, label) {
    var timer;
    return Promise.race([
      Promise.resolve(promise).then(function (value) { clearTimeout(timer); return value; }),
      new Promise(function (_, reject) {
        timer = setTimeout(function () { reject(timeoutError(label)); }, AUTH_TIMEOUT_MS);
      }),
    ]);
  }

  function text(err) {
    if (!err) return '';
    return String(err.message || err.error_description || err.msg || err || '');
  }

  // The order of these tests matters. "Invalid login credentials" contains the
  // word "invalid", and so does "Invalid API key" — the specific patterns have
  // to be tried before any general one, which is exactly the trap the old code
  // fell into.
  function classify(err) {
    var m = text(err).toLowerCase();
    var status = Number(err && (err.status || err.statusCode || (err.context && err.context.status))) || 0;

    if (err && err.__kind === 'timeout') return 'timeout';

    // The browser knows it has no connection. Worth checking before anything
    // that reads like a server answer, because there was no server answer.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';

    // A fetch that never reached the host: DNS, CORS, a paused project, a
    // blocked request. supabase-js surfaces these as a TypeError whose text
    // varies by browser — "Failed to fetch" on Chrome, "NetworkError when
    // attempting to fetch resource" on Firefox, "Load failed" on Safari.
    if (/failed to fetch|networkerror|load failed|fetch failed|network request failed/.test(m)) return 'network';

    if (status === 401 && /api key|apikey|jwt/.test(m)) return 'config';
    if (/invalid api key|no api key|api key found|invalid jwt|jwt expired/.test(m)) return 'config';

    if (status === 429 || /rate limit|too many requests|only request this after|after \d+ seconds/.test(m)) return 'rate_limited';

    if (/signups? not allowed|signups? are disabled|signup is disabled/.test(m)) return 'signups_disabled';
    if (/already registered|already been registered|user already exists/.test(m)) return 'already_registered';
    if (/email not confirmed|not confirmed|confirm your email/.test(m)) return 'unconfirmed';
    if (/invalid login credentials|invalid credentials|invalid email or password/.test(m)) return 'bad_credentials';
    if (/password should be|password is too short|weak password|password should contain/.test(m)) return 'weak_password';
    if (/unable to validate email|invalid email|email address.*invalid|email.*not valid/.test(m)) return 'bad_email';
    if (/for security purposes/.test(m)) return 'rate_limited';

    return 'unknown';
  }

  // What each kind of failure should say, per screen. The wording answers the
  // only question the customer actually has, which is "what do I do now" — so
  // a failure that is ours says it is ours rather than implying they got
  // something wrong.
  var COPY = {
    timeout: {
      any: 'We could not reach Verceil Bank just now. Check your connection and try again in a moment.',
    },
    offline: {
      any: 'You appear to be offline. Reconnect and try again.',
    },
    network: {
      any: 'We could not reach Verceil Bank. This is on our side or your network, not your details — please try again in a moment.',
    },
    config: {
      any: 'Verceil Bank is temporarily unavailable. Our team has been notified. Please try again shortly.',
    },
    rate_limited: {
      any: 'Too many attempts in a short time. Wait a minute and try again.',
    },
    signups_disabled: {
      signup: 'We are not accepting new applications at the moment. Please try again later.',
      any: 'That action is unavailable at the moment.',
    },
    already_registered: {
      signup: 'An account already exists for that email address. Sign in instead, or use "Forgot password" if you cannot get in.',
      any: 'That email address is already in use.',
    },
    unconfirmed: {
      signin: 'Confirm your email address first — check your inbox for the link we sent when you applied.',
      any: 'Confirm your email address first — check your inbox for the link.',
    },
    bad_credentials: {
      signin: 'That email address and password do not match an account.',
      any: 'Those details do not match an account.',
    },
    weak_password: {
      any: 'Choose a longer password — at least 8 characters.',
    },
    bad_email: {
      any: 'That email address does not look right. Check it and try again.',
    },
  };

  function describe(err, screen) {
    var kind = classify(err);
    var entry = COPY[kind];
    var message = entry ? (entry[screen] || entry.any) : '';

    // An unrecognised failure keeps the server's own words. A vague sentence
    // here would hide the one detail that identifies a new failure mode.
    if (!message) message = text(err) || 'Something went wrong. Please try again.';

    // Always. The customer gets the sentence above; whoever opens the console
    // gets the truth, including the kind this was filed under.
    try { console.error('[auth:' + (screen || 'auth') + '] ' + kind + ':', err); } catch (e) {}

    return { kind: kind, message: message };
  }

  // Asks the project directly what is wrong, for the console only. Run after a
  // failure that looks like a connection or configuration problem: it is the
  // difference between "not responding" and knowing whether the host answered,
  // whether the key was accepted, and whether sign-ups and email confirmation
  // are even switched on.
  //
  // Deliberately never shown to a customer — it describes the bank's setup.
  function probe() {
    var url = window.SUPABASE_URL;
    var key = window.SUPABASE_ANON_KEY;
    var report = { url: url, keyPresent: !!key };

    if (!url || !key) {
      report.verdict = 'js/config.js did not load, or SUPABASE_URL / SUPABASE_ANON_KEY are empty. ' +
        'Run `npm run build` (which runs scripts/generate-config.js) and confirm js/config.js is served.';
      console.error('[auth:probe]', report);
      return Promise.resolve(report);
    }

    return fetch(url.replace(/\/$/, '') + '/auth/v1/settings', { headers: { apikey: key } })
      .then(function (res) {
        report.status = res.status;
        if (res.status === 401) {
          report.verdict = 'The project answered but rejected the anon key. The key in js/config.js does not ' +
            'belong to this project, or it has been rotated. Copy it again from Supabase → Project Settings → API.';
          console.error('[auth:probe]', report);
          return report;
        }
        return res.json().then(function (body) {
          report.disable_signup = body.disable_signup;
          report.mailer_autoconfirm = body.mailer_autoconfirm;
          report.verdict = body.disable_signup
            ? 'Reachable, key accepted — but sign-ups are DISABLED for this project. ' +
              'Supabase → Authentication → Sign In / Providers → Allow new users to sign up.'
            : (body.mailer_autoconfirm === false
              ? 'Reachable, key accepted, sign-ups allowed. Email confirmation is ON, so a new account has no ' +
                'session until the emailed link is opened. Turn it off under Authentication → Sign In / Providers ' +
                '→ Confirm email if you want customers to land on the dashboard immediately.'
              : 'Reachable, key accepted, sign-ups allowed, email confirmation off. Auth is configured correctly.');
          console.info('[auth:probe]', report);
          return report;
        });
      })
      .catch(function (err) {
        report.error = String(err && err.message || err);
        report.verdict = 'Could not reach the project at all. The URL may be wrong, the project may be paused ' +
          '(Supabase pauses free projects after a week of inactivity — check the dashboard for a Restore button), ' +
          'or the request was blocked before it left the browser.';
        console.error('[auth:probe]', report);
        return report;
      });
  }

  // The supabase-js bundle comes from a CDN. If that request is blocked — an
  // ad blocker, a corporate proxy, an offline first load — window.supabase is
  // simply absent and every auth call fails with no explanation at all. This
  // names that case instead.
  function clientUnavailableMessage() {
    if (!window.supabase) {
      return 'Sign-in could not start because a required script did not load. ' +
        'Disable any content blocker for this site, then reload the page.';
    }
    return 'Verceil Bank is temporarily unavailable. Please try again shortly.';
  }

  window.VerceilAuth = {
    AUTH_TIMEOUT_MS: AUTH_TIMEOUT_MS,
    withTimeout: withTimeout,
    classify: classify,
    describe: describe,
    probe: probe,
    clientUnavailableMessage: clientUnavailableMessage,
    // Kinds where the fault is ours rather than the customer's, so the page
    // knows when to run the probe.
    isOurFault: function (kind) {
      return kind === 'timeout' || kind === 'network' || kind === 'config' ||
             kind === 'signups_disabled' || kind === 'unknown';
    },
  };
})();
