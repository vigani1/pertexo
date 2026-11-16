import { isUniqueConstraintFailure } from '@pertexo/database/primitives';
import type { Pool } from 'pg';
import type { FederationDiscovery } from '@pertexo/contracts';

import {
  startFederationJourney,
  testOrganizationProvider,
} from './organization-sign-in.js';

import { withPlatformTransaction } from '@pertexo/database/platform';

import type { FederationScope } from '../management/federation-management.types.js';

import { SignInProofRejectedError } from '../accounts/sign-in-proof.errors.js';

import {
  readFederationProvider,
  findFederationAttempt,
} from './federation-journeys.repository.js';

import { completeFederationJourney } from './complete.js';

import type {
  CompleteFederationJourney,
  StartFederationJourney,
  FederationCompletion,
} from './federation-journey.types.js';

import { readDomainDiscovery } from './organization-sign-in.repository.js';

/**
 * Sign-in has no member behind it, so all but the owner's provider test stay
 * off `withWorkspaceAccess`. `start` learns the workspace from the provider and
 * only a test has an owner; `complete` spans every linked workspace.
 */
export class OrganizationSignInCommands {
  constructor(
    private readonly input: Readonly<{ pool: Pool; sessionTtlSeconds: number }>,
  ) {}
  async discover(domain: string): Promise<FederationDiscovery> {
    const rows = await readDomainDiscovery(this.input.pool, domain);
    return {
      required: rows[0]?.require_sso ?? false,
      providers: rows.flatMap(({ id, name, kind }) => {
        const providerUnavailable =
          id === null || name === null || kind === null;
        return providerUnavailable ? [] : [{ id, name, kind }];
      }),
    };
  }
  provider(providerId: string, domain: string) {
    return readFederationProvider(this.input.pool, providerId, domain);
  }
  testProvider(
    input: FederationScope & Readonly<{ providerId: string; domainId: string }>,
  ) {
    return testOrganizationProvider(this.input.pool, input);
  }
  start(input: StartFederationJourney): Promise<void> {
    return startFederationJourney(this.input.pool, input);
  }
  find(stateDigest: Buffer, browserDigest: Buffer) {
    return findFederationAttempt(this.input.pool, stateDigest, browserDigest);
  }
  complete(input: CompleteFederationJourney): Promise<FederationCompletion> {
    return withPlatformTransaction(this.input.pool, (client) =>
      completeFederationJourney(client, input, this.input.sessionTtlSeconds),
    ).catch((error: unknown) => {
      const proofRefused =
        error instanceof SignInProofRejectedError ||
        isUniqueConstraintFailure(error);
      if (proofRefused) return { kind: 'failed' } as const;
      throw error;
    });
  }
}
