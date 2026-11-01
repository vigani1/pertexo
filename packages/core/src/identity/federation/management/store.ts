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
import type { FederationCommand, FederationScope } from './contract.js';
import type { DomainChallengeInput } from './contract.js';
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
    createOrganization: (input: Parameters<typeof createOrganization>[1]) =>
      createOrganization(lease.pool, input),
    linkWorkspace: (input: Parameters<typeof linkOrganizationWorkspace>[1]) =>
      linkOrganizationWorkspace(lease.pool, input),
    createDomain: (input: Parameters<typeof createDomain>[1]) =>
      createDomain(lease.pool, input),
    renewDomainChallenge: (input: Parameters<typeof renewDomainChallenge>[1]) =>
      renewDomainChallenge(lease.pool, input),
    verifyDomain: (input: Parameters<typeof verifyDomain>[1]) =>
      verifyDomain(lease.pool, input),
    removeDomain: (input: Parameters<typeof removeDomain>[1]) =>
      removeDomain(lease.pool, input),
    createProvider: (input: Parameters<typeof createProvider>[1]) =>
      createProvider(lease.pool, input),
    updateProvider: (input: Parameters<typeof updateProvider>[1]) =>
      updateProvider(lease.pool, input),
    removeProvider: (input: Parameters<typeof removeProvider>[1]) =>
      removeProvider(lease.pool, input),
    configureEnforcement: (
      input: Parameters<typeof configureDomainEnforcement>[1],
    ) => configureDomainEnforcement(lease.pool, input),
  };
}
