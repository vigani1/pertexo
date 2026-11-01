export { recordIdentitySecurityFact } from './facts.repository.js';
export { EmailProofCommands } from './email.repository.js';
export { AccountLinkingCommands } from './linking.repository.js';
export {
  changePasswordAndRevokeSessions,
  hasCredentialAccount,
  resetPasswordAndRevokeSessions,
  setupPasswordAndRevokeSessions,
  unlinkMethodAndRevokeSessions,
} from './security.repository.js';
export { SignUpAvailability, type SignUpMode } from './sign-up.js';
export { SocialSignInCommands } from './federation/social/sign-in.repository.js';
export { OrganizationSignInCommands } from './federation/journeys/organization-sign-in.repository.js';
export {
  authorizeCredentialSignIn,
  identityEmailChangeEligibility,
} from './federation/sessions/authority.repository.js';
export { isAuthenticationSessionAllowed } from './federation/sessions/lookup.queries.js';
export {
  createFederationManagementStore,
  type FederationManagementStore,
} from './federation/management/store.js';
export { FederationConflictError } from './federation/management/errors.js';
export {
  createDirectoryStore,
  type DirectoryStore,
} from './federation/provisioning/store.js';
export type {
  DirectoryGroup,
  DirectoryGroupValues,
  DirectoryPrincipal,
  DirectoryQuery,
  DirectoryRole,
  DirectoryUser,
  DirectoryUserProfile,
  DirectoryUserValues,
} from './federation/provisioning/contract.js';
export { DirectoryError } from './federation/provisioning/errors.js';
export { DIRECTORY_LIMITS } from './federation/provisioning/limits.js';
export {
  createTwoFactorRecoveryStore,
  type TwoFactorRecoveryStore,
} from './two-factor/store.js';
export type { TwoFactorRecoveryResult } from './two-factor/contract.js';

// Other areas reach these directly (ADR 091).
export type {} from './federation/provisioning/management/detach.repository.js';
export type {} from './federation/sessions/policy.js';
export type {} from './federation/sessions/recovery.queries.js';
