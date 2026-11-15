/**
 * Bounds on an email address. Two lengths exist on purpose: a newly entered
 * address (sign-up, email change, invitations, mail senders and recipients)
 * is held to RFC 5321's forward path, but accounts stored before that bound
 * may hold up to the column's width, and every lookup of an existing
 * account (sign-in, SSO, SCIM, password reset) must still find them.
 */
export const EMAIL_ADDRESS_LIMITS = Object.freeze({
  // `a@b` is the shortest address.
  minimumCharacters: 3,
  // A newly entered address: the longest forward path, without its brackets.
  newAddressCharacters: 254,
  // An existing account's address: the users column's width.
  storedAddressCharacters: 320,
  localPartCharacters: 64,
  domainCharacters: 253,
  // A domain needs a name and a top-level label.
  minimumDomainLabels: 2,
});
