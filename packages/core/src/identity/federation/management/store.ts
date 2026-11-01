import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
  type Role,
  type WorkspaceStatusList,
} from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';

import {
  withWorkspaceAccess,
  type WorkspaceActor,
} from '../../../shared/workspace-access.js';
import { requireFederationOwner } from './authority.repository.js';
import type {
  ConfigureEnforcementInput,
  CreateDomainInput,
  CreateOrganizationInput,
  CreateProviderInput,
  DomainChallengeInput,
  DomainCommand,
  FederationCommand,
  FederationScope,
  LinkWorkspaceInput,
  RemoveProviderInput,
  UpdateProviderInput,
  VerifyDomainInput,
} from './contract.js';
import {
  createDomain,
  removeDomain,
  renewDomainChallenge,
  verifyDomain,
} from './domains.repository.js';
import { configureDomainEnforcement } from './enforcement.repository.js';
import {
  createOrganization,
  linkOrganizationWorkspace,
} from './organizations.repository.js';
import {
  createProvider,
  removeProvider,
  updateProvider,
} from './providers.repository.js';
import {
  checkFederationStoredSecrets,
  readDomainChallenge,
  readDomainVerificationResult,
  readFederationSettings,
} from './reads.queries.js';

export type FederationManagementStore = ReturnType<
  typeof createFederationManagementStore
>;

export function createFederationManagementStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  /** Owners and admins read sign-in settings; the role decides what they may do with them. */
  const read = <T>(
    actor: WorkspaceActor,
    statuses: WorkspaceStatusList,
    work: (client: PoolClient, role: Role) => Promise<T>,
  ) =>
    withWorkspaceAccess(
      lease.pool,
      actor,
      { mode: 'read', capability: 'governance:manage', statuses },
      work,
    );
  const ownerRead = <T>(
    actor: WorkspaceActor,
    work: (client: PoolClient) => Promise<T>,
  ) =>
    read(actor, ACTIVE_WORKSPACE_STATUSES, (client, role) => {
      requireFederationOwner(role, 'manage');
      return work(client);
    });
  return {
    close: () => lease.close(),
    settings: (scope: FederationScope) =>
      read(scope, BROWSABLE_WORKSPACE_STATUSES, (client, role) =>
        readFederationSettings(client, scope, role),
      ),
    domainChallenge: (input: DomainChallengeInput) =>
      ownerRead(input, (client) => readDomainChallenge(client, input)),
    checkStoredSecrets: (
      check: (sealed: unknown, workspaceId: string, providerId: string) => void,
    ) => checkFederationStoredSecrets(lease.pool, check),
    verificationResult: (input: FederationCommand & DomainChallengeInput) =>
      ownerRead(input, (client) => readDomainVerificationResult(client, input)),
    createOrganization: (input: CreateOrganizationInput) =>
      createOrganization(lease.pool, input),
    linkWorkspace: (input: LinkWorkspaceInput) =>
      linkOrganizationWorkspace(lease.pool, input),
    createDomain: (input: CreateDomainInput) => createDomain(lease.pool, input),
    renewDomainChallenge: (input: DomainCommand) =>
      renewDomainChallenge(lease.pool, input),
    verifyDomain: (input: VerifyDomainInput) => verifyDomain(lease.pool, input),
    removeDomain: (input: DomainCommand) => removeDomain(lease.pool, input),
    createProvider: (input: CreateProviderInput) =>
      createProvider(lease.pool, input),
    updateProvider: (input: UpdateProviderInput) =>
      updateProvider(lease.pool, input),
    removeProvider: (input: RemoveProviderInput) =>
      removeProvider(lease.pool, input),
    configureEnforcement: (input: ConfigureEnforcementInput) =>
      configureDomainEnforcement(lease.pool, input),
  };
}
