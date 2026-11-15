/** What the identity settings may hold. */
export const IDENTITY_SETTING_LIMITS = Object.freeze({
  secretMinimumCharacters: 32,
  secretMaximumCharacters: 512,
  clientIdCharacters: 512,
  clientSecretCharacters: 1_024,
  appleClientSecretCharacters: 4_096,
});
