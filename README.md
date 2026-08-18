# Verceil Bank

A vanilla-JS banking app — no framework, no bundler, no build step beyond
compiling Tailwind once. The dashboard shell is the only thing loaded up front;
every screen is fetched and imported the moment it is opened, and torn down
again when it closes.

## Why it is built this way

| The old single file | This |
|---|---|
| Tailwind CDN compiled all CSS in the browser on every load | Tailwind compiled once at build time into a static `.css` |
| All ~40 screens sat in the DOM permanently, hidden with CSS | Only the open screen exists in the DOM; it is cleared on close |
| All JS parsed on initial load | Each screen's JS is `import()`-ed only when opened |
| One 6,800-line file | ~90 small files, fetched as needed |

## Setup

```bash
npm install
export SUPABASE_URL="https://xxxx.supabase.co"
export SUPABASE_ANON_KEY="your-anon-key"
npm run build       # or: npm run dev, to watch
```

ES modules and `fetch()` need a real HTTP server — `file://` will not do:

```bash
npx serve .
```

Then apply `supabase/setup.sql` once in the Supabase SQL editor. It is safe to
re-run and it reports what it found; `docs/supabase-setup.md` explains what each
section is for and what breaks without it.

To see how much of the support-mail path is already in place — the tables, the
edge functions, the mailbox secrets — run `npm run check:support` (add
`-- --verify` to log in to the mailbox, `-- --test` to send one). It only reads.
Its database-side counterpart is `supabase/check-support-mail.sql`, pasted into
the SQL editor.

### Configuration

The Supabase URL and anon key are **not** in tracked source. They are written at
build time into a generated, gitignored `js/config.js` by
`scripts/generate-config.js`, which runs as a `prebuild`/`predev` step.

**On Vercel:** set `SUPABASE_URL` and `SUPABASE_ANON_KEY` under *Settings →
Environment Variables* and redeploy. Vercel runs `npm run build`, which
regenerates `js/config.js` on every deploy.

**Locally:** export the two variables as above, or `cp js/config.example.js
js/config.js` and fill it in for quick testing. Note that a later
`build`/`dev` overwrites it from the environment.

## Layout

```
index.html              # Marketing site. No auth, no Supabase — the Sign in and
                        # Get Started links go to the two pages below.
signin.html             # Sign in, and password recovery
signup.html             # The account application: product, identity,
                        # SSN, address, email, password
reset-password.html     # Where the emailed reset link lands
dashboard.html          # The app shell: accounts, nav, modal, #page-root
css/
  input.css             # Tailwind directives + the app's own CSS
  output.css            # Generated — do not edit, not committed
js/
  main.js               # The shell: Supabase, helpers, theme, auth guard, loadPage()
  config.js             # Generated — gitignored, do not edit
  shared/
    account-products.js # The product catalogue and the joint-ownership rule
    activity.js         # The ledger, the event log, the offline outbox, Realtime
    receipt.js          # The success receipt every payment flow ends on
    ...
  pages/
    open-account.js     # One module per screen
    joint-account.js
    ...
pages/
  open-account.html     # One markup fragment per screen
  joint-account.html
  ...
supabase/
  setup.sql             # Everything the database needs, in the order it needs it
  check-support-mail.sql # Read-only: what the support path already has, from SQL
  functions/            # Edge functions: the deposit webhook, and support mail
                        # out through the support mailbox
docs/
  supabase-setup.md     # What setup.sql does, section by section
```

## Adding a screen

Every screen is exactly two files.

### 1. `pages/<name>.html` — markup only

The page's inner markup. No outer `hidden fixed inset-0` wrapper — `#page-root`
is that already — and the back button is `data-action="close"`.

### 2. `js/pages/<name>.js` — logic only

```js
let listeners = [];
function on(el, evt, fn) { el.addEventListener(evt, fn); listeners.push(() => el.removeEventListener(evt, fn)); }

export function init(root, ctx) {
  const { supabaseClient, getCurrentUser, genRef, formatCurrency, showModal, close, loadPage } = ctx;

  on(root.querySelector('[data-action="close"]'), 'click', close);
  // ...the page's logic, scoped to `root`
}

export function cleanup() {
  listeners.forEach(off => off());
  listeners = [];
}
```

Four rules that matter:

1. **Scope queries to `root`.** `root.querySelector('#x')`, never
   `document.getElementById('x')`. The page only exists while open, and this is
   what keeps ids from colliding across screens.
2. **Register listeners through `on()`**, so `cleanup()` can remove them all.
   Without it you leak a listener every time the screen is reopened.
3. **Use `ctx`, not globals.** Supabase and every shared helper are passed in.
4. **Rules live in `js/shared/`, not in the screen.** A figure or a policy
   quoted on two screens belongs in one module both read — see
   `account-products.js` for the products and the joint-ownership rule, and the
   opening-terms constants exported from `main.js`.

Open it with `loadPage('your-page-name')`, or from markup with
`<button data-page="your-page-name" class="page-open-btn">`.

## Things that are true here and easy to get wrong

- **`hidden` means hidden.** Every custom rule in `input.css` is emitted after
  `@tailwind utilities`, so any component that sets `display` would outrank
  `.hidden` at equal specificity. `.hidden { display: none !important }` at the
  top of the file settles it for every component, present and future.
- **Never `upsert()` against `accounts`.** Postgres checks UPDATE privilege on
  the SET list before it runs, and a customer session only has it on
  `account_number` — so the upsert fails and the screen reports an account it
  never opened. `openAccountRow()` in `main.js` is the one place accounts are
  opened; call it.
- **An account exists only if a row says so.** Nothing on the dashboard is drawn
  from the markup. A customer chooses one product at sign-up, savings comes with
  it, and everything else is offered rather than assigned.
- **Linking an external account and being allowed to send to it are separate.**
  Anybody may link one and the row is written immediately; transfers to it are
  held for 30 days and then activated by customer care. `external_accounts.status`
  is not a column a customer session may write — at insert or at update — because
  the same stolen session that links an account would otherwise activate it. The
  refusal is shown when a transfer is attempted, not when the account is added.
  See `readExternalAccountStanding()` in `js/shared/account-products.js`.
- **The activity outbox is keyed per customer.** One shared queue on a device
  where two people bank mixes their rows, and a row written under the wrong
  session is refused by RLS forever — which stops every later ledger write on
  that device. See the note at the top of `js/shared/activity.js`.

## Optional

For production you can bundle, though native ES modules work as they are:

```bash
npx esbuild js/main.js --bundle --splitting --format=esm --minify --outdir=dist
```
