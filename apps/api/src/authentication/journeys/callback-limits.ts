/** What a provider's sign-in callback may carry: a form post's size and each parameter's length. */
export const CALLBACK_LIMITS = Object.freeze({
  formBytes: 32 * 1_024,
  // Pertexo's own state: 32 random bytes in base64url.
  stateCharacters: 43,
  codeCharacters: 4_096,
  issuerCharacters: 2_048,
});
