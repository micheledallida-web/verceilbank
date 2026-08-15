// The deposit rate, and the disclosure that has to travel with it.
//
// Regulation DD / Truth in Savings (12 CFR 1030.8(c)) is what makes this a
// shared module rather than a number typed onto each screen: once an APY is
// advertised, the advertisement also has to carry the minimum balance needed
// to obtain it, that fees may reduce earnings, and — for a variable rate —
// that it can change after the account is opened. A rate quoted on six
// screens with the disclosure on none of them is the failure mode.
//
// The rate is flat: interest-details applies it to the whole balance, with no
// tier and no qualifying activity anywhere in the code. The copy said "up to
// 4.00%", which implies conditions that do not exist and understates what the
// account actually pays. It now says what it does. If tiers or qualifying
// activity are ever introduced, "up to" comes back — with the tiers disclosed
// beside it, which is what Reg DD requires of a tiered account.
export const APY = 0.04;

export const APY_LABEL = `${(APY * 100).toFixed(2)}% APY`;

export const APY_DISCLOSURE =
  'Annual Percentage Yield (APY) is variable and may change at any time, '
  + 'including after your account is opened. No minimum balance is required to '
  + 'open the account or to obtain the advertised APY. Fees may reduce earnings.';
