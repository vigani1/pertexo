import { SECRET_TOKEN_CHARACTERS } from '../../identity/secret-token.js';

/** What a provider's sign-in callback may carry: a form post's size and each parameter's length. */
export const CALLBACK_LIMITS = Object.freeze({
  formBytes: 32 * 1_024,
  // Pertexo's own state is a journey token.
  stateCharacters: SECRET_TOKEN_CHARACTERS,
  codeCharacters: 4_096,
  issuerCharacters: 2_048,
});
