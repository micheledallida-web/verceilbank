// ==================== PRODUCTS, AND HOW THEY ARE OWNED ====================
// The bank's product catalogue and its joint-ownership rule, in one module,
// because both are quoted on more than one screen and a rule stated in two
// places is a rule that will eventually disagree with itself.
//
// Sign-up quotes the products. Open an Account quotes them again. The Joint
// Accounts screen and the joint branch of Open an Account both quote the
// sixty-day rule. All of them read it from here.

// ---------- The products a customer can open ----------
// `key` is the value written to accounts.account_type, and it is the only thing
// in this file the database sees. Everything else is what a person reads.
//
// `openWith` is WHERE a product can be chosen, and the two are not the same
// place:
//
//   'signup' — the application form. An applicant picks the account they are
//              opening.
//   'app'    — Open an Account, used by somebody who already banks here and
//              wants another one: a second checking account, interest checking
//              alongside it, an investment account.
//
// Both checking products are on both surfaces. That is the whole point of Open
// an Account — a member who already holds a checking account and the savings
// that came with it, coming back for more.
//
// The investment account is 'app' only. It was on the sign-up form, which meant
// offering a product that can lose money to somebody the bank had not yet
// identified; it now follows the rule the credit card and the IRA already
// follow, and is opened from Open an Account behind a session.
//
// Nothing reads the 'signup' surface yet — signup.html carries its cards in
// markup — so this list and that page have to be kept in step by hand until it
// does. They are in step: there is no investment card on the sign-up form.
//
// Savings is 'app' only, and the reason is the interesting one. It is not
// chosen at sign-up because it is not optional there: provision_user opens it
// alongside whatever the applicant picked, so a brand-new customer always has
// one without ever being asked.
//
// That rule applies to becoming a customer, and to nothing after it. A member
// opening a second checking account already has their savings, and bundling
// another one onto it is the bank deciding something on their behalf it has no
// reason to decide twice. So from Open an Account, savings is an ordinary
// product: offered to a customer who somehow does not hold one, shown as
// already held to everybody else, and never added to anything automatically.
export const ACCOUNT_PRODUCTS = [
  {
    key: 'checking',
    name: 'Verceil Checking',
    tagline: 'Everyday banking for spending, direct deposit and transfers',
    note: 'No monthly maintenance fee',
    accent: '#2563EB',
    openWith: ['signup', 'app'],
    features: [
      'No monthly maintenance fee',
      'Direct deposit up to two days early',
      'Zelle® transfers and mobile check deposit',
      'FDIC insured to the applicable limits',
    ],
  },
  {
    key: 'interest_checking',
    name: 'Verceil Interest Checking',
    tagline: 'A checking account that earns interest on your balance',
    note: 'Up to 4.00% APY · No monthly fees',
    accent: '#1D4ED8',
    openWith: ['signup', 'app'],
    features: [
      'Earn up to 4.00% APY on your balance',
      'No monthly maintenance fee',
      'Everything Verceil Checking does',
      'FDIC insured to the applicable limits',
    ],
  },
  {
    key: 'savings',
    name: 'High-Yield Savings',
    tagline: 'Set money aside and earn on every dollar',
    note: '4.00% APY',
    accent: '#059669',
    // Automatic at sign-up, and no longer offered on Open an Account either —
    // it sits with the investment account under Invest instead. provision_user
    // still opens it alongside whatever a new applicant picks, so nobody is
    // left without one; this only stops it being a tick box on that screen.
    openWith: [],
    // Offered ALONGSIDE another account rather than instead of one. Every other
    // product on this list answers "which account are you opening?"; savings
    // answers "and do you want one of these with it?", which is a different
    // question and needs a different control — a checkbox, not a radio. Open an
    // Account reads this flag and draws it accordingly.
    addOn: true,
    // Nothing here about WHEN it was opened. That differs by reader — it came
    // with a member's first account, and it is a thing a member without one is
    // choosing right now — so the card says it in its footer instead.
    features: [
      '4.00% APY on the whole balance',
      'No minimum balance to earn interest',
      'No monthly maintenance fee',
      'FDIC insured to the applicable limits',
    ],
  },
  {
    key: 'investments',
    name: 'Investment Account',
    tagline: 'Buy and hold stocks, ETFs and mutual funds',
    note: 'Not FDIC insured · May lose value',
    accent: '#8B5CF6',
    // Neither surface. It came off sign-up because it offers a product that can
    // lose money to somebody the bank has not identified, and it is now off
    // Open an Account as well: the investment account and savings are their own
    // pair, reached from Invest, rather than two more answers to "which
    // checking account are you opening?".
    //
    // Nothing else reads this list for the investment account, so it is the one
    // switch — but see the note at the top of this file about what that leaves.
    openWith: [],
    // The one product on this list that can lose money, and the screens that
    // offer it say so where it is offered rather than in a footnote.
    risk: 'Investment products are not deposits, are not FDIC insured, are not guaranteed by the bank and may lose value.',
    features: [
      'Stocks, ETFs and mutual funds',
      'No account minimum to open',
      'Real-time portfolio tracking',
      'Not FDIC insured · May lose value',
    ],
  },
];

export const ACCOUNT_PRODUCTS_BY_KEY = ACCOUNT_PRODUCTS.reduce(
  (acc, product) => ({ ...acc, [product.key]: product }),
  {},
);

// What a given surface may offer. Defaults to 'app', because Open an Account is
// the only screen that reads this list — sign-up carries its own markup, and
// this is the record of what it is allowed to show.
export function offerableProducts(surface = 'app') {
  return ACCOUNT_PRODUCTS.filter((product) => (product.openWith || []).includes(surface));
}

// ---------- How an account is owned ----------
export const OWNERSHIP_INDIVIDUAL = 'individual';
export const OWNERSHIP_JOINT = 'joint';

// ---------- The joint-ownership rule ----------
// A joint owner is a second person with equal, unrestricted access to the
// money: they can withdraw all of it, close the account, and their own
// creditors can reach it. That is not a setting to be flipped in an app, and no
// bank lets you do it in one — it needs both people identified, both signatures
// on the ownership agreement, and a check on the relationship behind the
// request, which is what stops an app from being the instrument of somebody
// being talked into signing away their savings.
//
// So joint ownership goes through a person, always: a call to customer care or
// an email to support. The screens say that plainly rather than showing a
// button that cannot work.
//
// And it is not available immediately. An account has to have been held for
// sixty days before a second owner can be added to it — the same sixty days the
// opening deposit is measured over, so the account has established itself
// before somebody else is given the keys to it.
export const JOINT_OWNER_MIN_DAYS = 60;

// Customer care. The same number the Support and Help Center screens print, so
// the bank has one phone number rather than one per screen.
export const SUPPORT_PHONE = '+18005550123';
export const SUPPORT_PHONE_DISPLAY = '(800) 555-0123';
export const SUPPORT_HOURS = 'Monday to Friday, 8am–9pm ET · Saturday, 9am–5pm ET';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function wholeDaysBetween(from, to) {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

export function formatLongDate(date) {
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * How long this customer has held an account, and whether that is long enough
 * to add a joint owner.
 *
 * Measured from the OLDEST account they hold, not the newest and not the one
 * they happen to be looking at. Sixty days of being a customer is what the rule
 * is about; opening a second account last week does not restart it, and it
 * would be a strange bank that reset your standing every time you took another
 * product.
 *
 * An unknown date reads as not yet eligible. Guessing in the customer's favour
 * would have the screen promise something the bank then refuses on the phone.
 */
export async function readJointOwnerEligibility({ supabaseClient, getCurrentUser }) {
  const unknown = {
    known: false,
    eligible: false,
    daysHeld: 0,
    daysRemaining: JOINT_OWNER_MIN_DAYS,
    eligibleOn: '',
    minDays: JOINT_OWNER_MIN_DAYS,
  };

  if (!supabaseClient) return unknown;

  try {
    const user = await getCurrentUser();
    if (!user) return unknown;

    const { data, error } = await supabaseClient
      .from('accounts')
      .select('created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw error;

    // The account rows are the record. The auth user's own created_at is the
    // fallback for a customer whose rows predate that column being written.
    const since = new Date((data && data.created_at) || user.created_at);
    if (isNaN(since)) return unknown;

    const daysHeld = Math.max(0, wholeDaysBetween(since, new Date()));
    const eligibleDate = new Date(since.getTime() + JOINT_OWNER_MIN_DAYS * MS_PER_DAY);

    return {
      known: true,
      eligible: daysHeld >= JOINT_OWNER_MIN_DAYS,
      daysHeld,
      daysRemaining: Math.max(0, JOINT_OWNER_MIN_DAYS - daysHeld),
      eligibleOn: formatLongDate(eligibleDate),
      minDays: JOINT_OWNER_MIN_DAYS,
    };
  } catch (err) {
    console.error('Joint owner eligibility error:', err);
    return unknown;
  }
}
