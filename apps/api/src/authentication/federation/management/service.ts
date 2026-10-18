import { createHmac } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import type { ApplicationSecretEnvelope } from '@pertexo/integrations/server';
import {
  FederationConflictError,
  WorkspaceAccessDeniedError,
  type FederationManagementStore,
} from '@pertexo/database/tenant-access';
import { IdempotencyConflictError } from '@pertexo/database/platform';
import { canonicalJson } from '@pertexo/workflow-model';
import {
  applicationError,
  throwApplicationError,
} from '../../../platform/http/index.js';
import { federationSecretContext } from '../protocol/oidc.js';
import type {
  OidcProviderCreate,
  OidcProviderUpdate,
} from '@pertexo/contracts';
type Scope = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
}>;
type Command = Scope &
  Readonly<{ idempotencyKey: string; expectedRevision: number }>;
export class FederationManagementService {
  constructor(
    readonly store: FederationManagementStore,
    private readonly envelope: ApplicationSecretEnvelope | undefined,
    private readonly secret: string,
  ) {}
  async settings(scope: Scope) {
    const result = await this.store.settings(scope);
    return this.envelope === undefined
      ? {
          ...result,
          configured: false,
          canManage: false,
          reason:
            'Configure AUTH_FEDERATION_KEY and AUTH_FEDERATION_KEY_VERSION on the API to enable organization sign-in.',
        }
      : result;
  }
  requireConfigured(): ApplicationSecretEnvelope {
    if (this.envelope === undefined)
      throwApplicationError(
        applicationError('request.invalid', {
          safeDetail:
            'Organization sign-in needs AUTH_FEDERATION_KEY and AUTH_FEDERATION_KEY_VERSION on the API.',
        }),
      );
    return this.envelope;
  }
  createProvider(command: Command & OidcProviderCreate) {
    const envelope = this.requireConfigured();
    const { clientSecret, ...input } = command;
    return this.store.createOidcProvider({
      ...input,
      sealSecret: (providerId) =>
        envelope.seal(
          clientSecret,
          federationSecretContext(input.workspaceId, providerId),
        ),
      secretFingerprint: this.fingerprint(input.workspaceId, clientSecret),
    });
  }
  updateProvider(
    command: Command & OidcProviderUpdate & Readonly<{ providerId: string }>,
  ) {
    const envelope = this.requireConfigured();
    const { clientSecret, ...input } = command;
    return this.store.updateOidcProvider({
      ...input,
      ...(clientSecret === undefined
        ? {}
        : {
            sealedSecret: envelope.seal(
              clientSecret,
              federationSecretContext(input.workspaceId, input.providerId),
            ),
            secretFingerprint: this.fingerprint(
              input.workspaceId,
              clientSecret,
            ),
          }),
    });
  }
  async verifyDomain(input: Command & Readonly<{ domainId: string }>) {
    this.requireConfigured();
    const replay = await this.store.verificationResult(input);
    if (replay !== null) return replay;
    const proof = await this.store.domainChallenge(input);
    const resolver = new Resolver({ timeout: 3000, tries: 1 });
    const abort = () => {
      resolver.cancel();
    };
    input.signal?.throwIfAborted();
    input.signal?.addEventListener('abort', abort, { once: true });
    let records: string[][];
    try {
      records = await resolver.resolveTxt(`_pertexo.${proof.domain}`);
    } catch {
      input.signal?.throwIfAborted();
      throw new FederationConflictError(
        'dns_unverified',
        'The current verification TXT record was not found. Add it to DNS and try again.',
      );
    } finally {
      input.signal?.removeEventListener('abort', abort);
    }
    if (
      !records.some(
        (parts) => parts.join('') === `pertexo-verification=${proof.challenge}`,
      )
    )
      throw new FederationConflictError(
        'dns_unverified',
        'The verification TXT record does not match the current challenge.',
      );
    return this.store.verifyDomain({
      ...input,
      observedChallenge: proof.challenge,
    });
  }
  private fingerprint(workspaceId: string, value: string): string {
    return createHmac('sha256', this.secret)
      .update(
        canonicalJson({
          purpose: 'organization-provider-secret',
          workspaceId,
          value,
        }),
      )
      .digest('hex');
  }
  async perform<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error: unknown) {
      if (error instanceof WorkspaceAccessDeniedError)
        throwApplicationError(applicationError('resource.not_found'));
      if (error instanceof IdempotencyConflictError)
        throwApplicationError(applicationError('request.idempotency_conflict'));
      if (error instanceof FederationConflictError)
        throwApplicationError(
          applicationError(
            error.reason === 'owner_required'
              ? 'auth.forbidden'
              : error.reason === 'dns_unverified'
                ? 'request.invalid'
                : 'workspace.conflict',
            { safeDetail: error.message },
          ),
        );
      throw error;
    }
  }
}
