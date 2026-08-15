// Whether VerceilBank may represent itself as FDIC-insured — in one place.
//
// Representing federal deposit insurance that does not exist is a federal
// offence: FDI Act § 18(a)(4) (12 U.S.C. § 1828(a)(4)) and 18 U.S.C. § 709.
// It is not a wording problem, it is a claim that has to be true before it is
// made, so it stays off until membership is confirmed and every surface reads
// it from here instead of asserting it locally. Five screens and the generated
// statement PDFs were each making the claim on their own; scattered claims are
// how a site ends up insured in the app and silent in the policy, which is
// where this started.
//
// TO TURN IT ON, once membership is confirmed, and not before:
//   1. set FDIC_MEMBERSHIP_CONFIRMED to true, and
//   2. uncomment the membership block in clause 6 of banking-policy.html and
//      fill in the certificate number.
// Those two changes turn the claim on everywhere it belongs, and nowhere else.
export const FDIC_MEMBERSHIP_CONFIRMED = false;

// Spread into a deposit product's feature list. While membership is
// unconfirmed the line is absent rather than hedged — a feature list is no
// place to explain a pending regulatory status.
export function depositInsuranceFeature() {
  return FDIC_MEMBERSHIP_CONFIRMED ? ['FDIC insured to the applicable limits'] : [];
}

// Footer stamped on generated statements. "Equal Housing Lender" is a fair
// lending statement rather than an insurance one, so it stands either way.
export function documentFooterLine() {
  return FDIC_MEMBERSHIP_CONFIRMED
    ? 'Member FDIC - Equal Housing Lender'
    : 'Equal Housing Lender';
}

// Settings → FDIC insurance. The non-deposit half is true whatever the
// membership status, and it is the half customers most often assume the
// opposite of, so it is always said. The coverage half depends on membership.
export function depositInsuranceDisclosure() {
  return FDIC_MEMBERSHIP_CONFIRMED
    ? 'Deposit accounts at Verceil Bank, N.A. are insured by the FDIC up to $250,000 per depositor, per ownership category. Investment products are not deposits, are not FDIC insured and may lose value.'
    : 'Investment and wealth products are not deposits, are not insured by the FDIC or any federal government agency, are not guaranteed by the Bank, and may lose value. See the Customer Banking Policy for how deposit insurance works and what it covers.';
}

// The row label in Settings, which should not assert membership either.
export function depositInsuranceLabel() {
  return FDIC_MEMBERSHIP_CONFIRMED ? 'FDIC insurance' : 'Deposit insurance';
}
