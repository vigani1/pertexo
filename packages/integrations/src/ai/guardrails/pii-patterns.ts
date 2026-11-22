import type {
  GuardrailsDiagnostics,
  GuardrailsReason,
} from '@pertexo/node-sdk';

type PiiReason = Extract<GuardrailsReason, `pii.${string}`>;

type Pattern = Readonly<{
  reason: PiiReason;
  candidates: RegExp;
  valid?: (candidate: string) => boolean;
}>;

// Every repetition has a fixed maximum width. Lookarounds prevent a candidate
// from starting or ending inside a longer token of the same kind.
const PATTERNS: readonly Pattern[] = [
  {
    reason: 'pii.email',
    candidates:
      /(?<![a-z0-9.!#$%&'*+/=?^_`{|}~@-])[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,8}[a-z]{2,63}(?![a-z0-9@-]|\.[a-z0-9])/gu,
    valid: (candidate) => {
      const local = candidate.slice(0, candidate.indexOf('@'));
      return (
        !local.startsWith('.') && !local.endsWith('.') && !local.includes('..')
      );
    },
  },
  {
    reason: 'pii.phone',
    candidates:
      /(?<![\p{L}\p{N}+])(?:(?:\+?1[ .-]?)?(?:\([2-9]\d{2}\)[ .-]?|[2-9]\d{2}[ .-]?)[2-9]\d{2}[ .-]?\d{4}|\+[1-9](?:[ .-]?\d){7,14})(?![\p{L}\p{N}]|[ .-]\d)/gu,
  },
  {
    reason: 'pii.payment_card',
    candidates:
      /(?<![\p{L}\p{N}]|\d[ -])\d(?:[ -]?\d){12,18}(?![\p{L}\p{N}]|[ -]\d)/gu,
    valid: validLuhn,
  },
  {
    reason: 'pii.national_id',
    // US Social Security numbers exclude these area, group and serial values.
    candidates:
      /(?<![\p{L}\p{N}-])(?!(?:000|666|9\d{2})-)\d{3}-(?!00-)\d{2}-(?!0000)\d{4}(?![\p{L}\p{N}-])/gu,
  },
  {
    reason: 'pii.national_id',
    // Canadian Social Insurance numbers use a checksum and grouped digits.
    candidates:
      /(?<![\p{L}\p{N}]|\d[ -])[1-79]\d{2}([ -])\d{3}\1\d{3}(?![\p{L}\p{N}]|[ -]\d)/gu,
    valid: validLuhn,
  },
];

const DECIMAL_RADIX = 10;
const LUHN_DOUBLE = 2;
const IBAN_MODULUS = 97;
const IBAN_CHECK_DIGITS_START = 2;
const IBAN_HEADER_LENGTH = 4;
const IBAN_GROUP_LENGTH = 4;
const IBAN_MIN_CHECK_DIGITS = 2;
const IBAN_MAX_CHECK_DIGITS = 98;
const ASCII_ZERO = '0'.charCodeAt(0);
const ASCII_LOWERCASE_A = 'a'.charCodeAt(0);

export function countPii(text: string, reasons: GuardrailsDiagnostics): void {
  const ibans = countIbans(text);
  if (ibans > 0) reasons['pii.iban'] = ibans;
  for (const { reason, candidates, valid } of PATTERNS) {
    let count = 0;
    for (const [candidate] of text.matchAll(candidates)) {
      if (valid === undefined || valid(candidate)) count += 1;
    }
    if (count > 0) reasons[reason] = (reasons[reason] ?? 0) + count;
  }
}

function validLuhn(candidate: string): boolean {
  const digits = candidate.replaceAll(/[ -]/gu, '');
  if (digits.startsWith('0')) return false;
  let sum = 0;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const digit = Number(digits[index]);
    const doubled =
      (digits.length - index) % LUHN_DOUBLE === 0 ? digit * LUHN_DOUBLE : digit;
    sum += doubled >= DECIMAL_RADIX ? doubled - (DECIMAL_RADIX - 1) : doubled;
  }
  return sum % DECIMAL_RADIX === 0;
}

// ISO 13616 country and check digits, followed by a country-specific account.
const IBAN_HEADERS = /(?<![\p{L}\p{N}])([a-z]{2})\d{2}/gu;
const IBAN_CHARACTER = /^[a-z0-9]$/u;
const IBAN_LENGTHS: Readonly<Record<string, number | undefined>> = {
  ad: 24,
  ae: 23,
  al: 28,
  at: 20,
  az: 28,
  ba: 20,
  be: 16,
  bg: 22,
  bh: 22,
  bi: 27,
  br: 29,
  by: 28,
  ch: 21,
  cr: 22,
  cy: 28,
  cz: 24,
  de: 22,
  dj: 27,
  dk: 18,
  do: 28,
  ee: 20,
  eg: 29,
  es: 24,
  fi: 18,
  fk: 18,
  fo: 18,
  fr: 27,
  gb: 22,
  ge: 22,
  gi: 23,
  gl: 18,
  gr: 27,
  gt: 28,
  hr: 21,
  hu: 28,
  ie: 22,
  il: 23,
  iq: 23,
  is: 26,
  it: 27,
  jo: 30,
  kw: 30,
  kz: 20,
  lb: 28,
  lc: 32,
  li: 21,
  lt: 20,
  lu: 20,
  lv: 21,
  ly: 25,
  mc: 27,
  md: 24,
  me: 22,
  mk: 19,
  mn: 20,
  mr: 27,
  mt: 31,
  mu: 30,
  ni: 32,
  nl: 18,
  no: 15,
  om: 23,
  pk: 24,
  pl: 28,
  ps: 29,
  pt: 25,
  qa: 29,
  ro: 24,
  rs: 22,
  sa: 24,
  sc: 31,
  sd: 18,
  se: 24,
  si: 19,
  sk: 24,
  sm: 27,
  so: 23,
  st: 25,
  sv: 28,
  tl: 23,
  tn: 24,
  tr: 26,
  ua: 29,
  va: 22,
  vg: 24,
  xk: 20,
  ye: 30,
};

function countIbans(text: string): number {
  let count = 0;
  let matchedUntil = 0;
  for (const header of text.matchAll(IBAN_HEADERS)) {
    const [prefix, country] = header;
    if (header.index < matchedUntil || country === undefined) continue;
    const length = IBAN_LENGTHS[country];
    if (length === undefined) continue;
    const start = header.index + prefix.length;
    const grouped = text[start] === ' ';
    let offset = start;
    let account = prefix;
    while (account.length < length) {
      if (
        grouped &&
        account.length % IBAN_GROUP_LENGTH === 0 &&
        text[offset++] !== ' '
      )
        break;
      const character = text[offset++];
      if (character === undefined || !IBAN_CHARACTER.test(character)) break;
      account += character;
    }
    if (
      account.length === length &&
      !IBAN_CHARACTER.test(text[offset] ?? '') &&
      validIbanChecksum(account)
    ) {
      count += 1;
      matchedUntil = offset;
    }
  }
  return count;
}

function validIbanChecksum(account: string): boolean {
  const checkDigits = Number(
    account.slice(IBAN_CHECK_DIGITS_START, IBAN_HEADER_LENGTH),
  );
  if (
    checkDigits < IBAN_MIN_CHECK_DIGITS ||
    checkDigits > IBAN_MAX_CHECK_DIGITS
  )
    return false;
  let remainder = 0;
  for (const character of account.slice(IBAN_HEADER_LENGTH) +
    account.slice(0, IBAN_HEADER_LENGTH)) {
    const code = character.charCodeAt(0);
    const numeric =
      code >= ASCII_LOWERCASE_A
        ? code - ASCII_LOWERCASE_A + DECIMAL_RADIX
        : code - ASCII_ZERO;
    remainder =
      (remainder *
        (numeric >= DECIMAL_RADIX
          ? DECIMAL_RADIX * DECIMAL_RADIX
          : DECIMAL_RADIX) +
        numeric) %
      IBAN_MODULUS;
  }
  return remainder === 1;
}
