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
// Savings is on the list but never offered: every customer already holds one —
// it is opened alongside whatever they choose, at sign-up and here — so it can
// never be something left to open. It is here so a savings row still has a
// name and a description wherever one is printed.
//
// THE BANK OFFERS TWO ACCOUNTS. Verceil Checking and Verceil Interest Checking
// were here and are gone: the bank does not do current accounts. Everything
// downstream of this list follows from it — sign-up, Open an Account, the
// dashboard cards, the transfer screens' account pickers — because this array
// is the catalogue and nothing else is allowed to hold a second opinion about
// what a customer can hold.
//
// If they are ever brought back, they come back here, and the screens pick them
// up on their own.
export const ACCOUNT_PRODUCTS = [
  {
    key: 'savings',
    name: 'High-Yield Savings',
    tagline: 'Set money aside and earn on every dollar',
    note: '4.00% APY',
    accent: '#059669',
    offerable: false,
    features: [
      '4.00% APY on the whole balance',
      'No minimum balance to earn interest',
      'Opened alongside every Verceil account',
      'FDIC insured to the applicable limits',
    ],
  },
  {
    key: 'investments',
    name: 'Investment Account',
    tagline: 'Buy and hold stocks, ETFs and mutual funds',
    note: 'Not FDIC insured · May lose value',
    accent: '#8B5CF6',
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

// What is genuinely on offer: everything except the accounts that come with
// membership rather than being chosen.
export function offerableProducts() {
  return ACCOUNT_PRODUCTS.filter((product) => product.offerable !== false);
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
