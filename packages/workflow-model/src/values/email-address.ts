/** RFC 5321 bounds on an email address, wherever one is checked. */
export const EMAIL_ADDRESS_LIMITS = Object.freeze({
  // `a@b` is the shortest address.
  minimumCharacters: 3,
  // The longest forward path, without its angle brackets.
  characters: 254,
  localPartCharacters: 64,
  domainCharacters: 253,
  // A domain needs a name and a top-level label.
  minimumDomainLabels: 2,
});
