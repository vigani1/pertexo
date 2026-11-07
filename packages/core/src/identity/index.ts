export { issuePasswordResetProof } from './password-reset.repository.js';
export { recordIdentitySecurityFact } from './facts.repository.js';
export { EmailProofCommands } from './email.repository.js';
export { AccountLinkingCommands } from './linking.repository.js';
export {
  changePasswordAndRevokeSessions,
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
export { isAuthenticationSessionAllowed } from './federation/sessions/lookup.repository.js';
export {
  createFederationManagementStore,
  type FederationManagementStore,
} from './federation/management/federation-management.store.js';
export { FederationConflictError } from './federation/management/federation-management.errors.js';
export {
  createDirectoryStore,
  type DirectoryStore,
} from './federation/provisioning/directory.store.js';
export type {
  DirectoryGroup,
  DirectoryGroupValues,
  DirectoryPrincipal,
  DirectoryQuery,
  DirectoryRole,
  DirectoryUser,
  DirectoryUserProfile,
  DirectoryUserValues,
} from './federation/provisioning/directory-provisioning.types.js';
export { DirectoryError } from './federation/provisioning/directory.errors.js';
export {
  createTwoFactorRecoveryStore,
  type TwoFactorRecoveryStore,
} from './two-factor/two-factor-recovery.store.js';
export type { TwoFactorRecoveryResult } from './two-factor/two-factor-recovery.types.js';

// Other areas reach these directly (ADR 091).
export type {} from './federation/provisioning/management/detach.repository.js';
export type {} from './federation/sessions/policy.js';
export type {} from './federation/sessions/recovery.repository.js';
export { revokeAuthenticationSession } from './federation/sessions/revocation.repository.js';

export { canonicalEmail } from './email-policy.js';
export { parseIdentityMetadata } from './identity-metadata.js';

export {
  readAccountProviderNames,
  readCredentialPasswordHash,
} from './account-security.repository.js';
