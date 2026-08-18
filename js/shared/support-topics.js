// The support shortcuts, in one place because two screens offer them.
//
// A row opens the new-message form with the category, subject and opening line
// already filled in. That started on the Fund account screen — payment details
// are issued per request, so the row's job was to open a message that already
// says what is being asked for — and it works for everything else a customer
// writes in about, which is why it now lives here rather than inside one page.
//
// `value` on a category is what is written to support_threads.category, so a
// label invented at the call site would file the message under General and
// support would see a card dispute and a rollover as the same pile.
//
// `group` decides which list a row appears under: 'funding' rows ask for
// payment details and belong on the screens where money is moved; 'common'
// rows are everything else and are the only ones the Contact Support screen
// offers, since nobody arrives there to ask how to pay in.

export const SUPPORT_TOPICS = [
  {
    label: 'Cards & PINs',
    group: 'common',
    body: 'I have a question about my card or PIN. Please get in touch.',
    category: 'card_application',
    icon: '<rect x="2" y="5" width="20" height="14" rx="3"></rect><path d="M2 10h20"></path><path d="M6 15h4"></path>',
  },
  {
    label: 'Disputes',
    group: 'common',
    body: 'I would like to dispute a transaction on my account. Please tell me what you need from me.',
    category: 'disputes',
    icon: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path>',
  },
  {
    label: 'Transfers',
    group: 'common',
    body: 'I have a question about a transfer on my account.',
    category: 'funding_ach',
    icon: '<path d="M7 7h11m0 0-4-4m4 4-4 4"></path><path d="M17 17H6m0 0 4 4m-4-4 4-4"></path>',
  },
  {
    label: 'Statements',
    group: 'common',
    body: 'I need a copy of an account statement. Please let me know how to get it.',
    category: 'general',
    icon: '<path d="M6 3h9l3 3v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"></path><path d="M9 9h6M9 13h6M9 17h4"></path>',
  },
  {
    label: 'Account access',
    group: 'common',
    body: 'I am having trouble getting into my account. Please help me restore access.',
    category: 'account_access',
    icon: '<rect x="4" y="10" width="16" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path>',
  },
  {
    label: 'Fees',
    group: 'common',
    body: 'I have a question about a fee on my account.',
    category: 'general',
    icon: '<path d="M19 5 5 19"></path><circle cx="7.5" cy="7.5" r="2.5"></circle><circle cx="16.5" cy="16.5" r="2.5"></circle>',
  },
  // Categories the rest of the app files messages under, which had no way in
  // from this screen — somebody asking about a joint owner or a rollover had
  // to find the category list themselves.
  {
    label: 'Joint account ownership',
    group: 'common',
    body: 'I would like to add or change a joint owner on my account. Please tell me the next steps.',
    category: 'account_ownership',
    icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>',
  },
  {
    label: 'Investments',
    group: 'common',
    body: 'I have a question about my investment or retirement account.',
    category: 'investments',
    icon: '<path d="M3 17l6-6 4 4 7-7"></path><path d="M14 8h6v6"></path>',
  },
  {
    label: 'Personal details',
    group: 'common',
    body: 'I need to update my personal details. Please tell me what you need from me.',
    category: 'personal_details',
    icon: '<circle cx="12" cy="8" r="4"></circle><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"></path>',
  },
  // The funding rows. Same shortcut the Fund account screen offers, and the
  // same wording, so a request that arrives from here is indistinguishable
  // from one that arrives from there.
  {
    label: 'Fund by Zelle',
    group: 'funding',
    category: 'funding_zelle',
    subject: 'Zelle funding request',
    body: 'I would like to fund my account via Zelle. Please send me the details.',
    icon: '<path d="M12 2v20"></path><path d="M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>',
  },
  {
    label: 'Fund by Cash App',
    group: 'funding',
    category: 'funding_cashapp',
    subject: 'Cash App funding request',
    body: 'I would like to fund my account via Cash App. Please send me the details.',
    icon: '<rect x="3" y="3" width="18" height="18" rx="5"></rect><path d="M14 9.5a3 3 0 0 0-4.5 2c0 2.5 5 1.5 5 4a3 3 0 0 1-4.5 2"></path><path d="M12 7v10"></path>',
  },
  {
    label: 'Fund by PayPal',
    group: 'funding',
    category: 'funding_paypal',
    subject: 'PayPal funding request',
    body: 'I would like to fund my account via PayPal. Please send me the details.',
    icon: '<path d="M3 7a2 2 0 0 1 2-2h11"></path><rect x="3" y="7" width="18" height="12" rx="2"></rect><circle cx="16.5" cy="13" r="1.3"></circle>',
  },
  {
    label: 'Fund by ACH transfer',
    group: 'funding',
    category: 'funding_ach',
    subject: 'ACH funding request',
    body: 'I would like to fund my account via ACH transfer. Please send me the details.',
    icon: '<path d="M3 10 12 4l9 6"></path><path d="M5 10v9"></path><path d="M19 10v9"></path><path d="M9 10v9"></path><path d="M15 10v9"></path><path d="M3 21h18"></path>',
  },
];
