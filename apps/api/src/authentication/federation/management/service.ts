import { createHmac } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import type { ApplicationSecretEnvelope } from '@pertexo/integrations/server';
import {
  FederationConflictError,
  type FederationManagementStore,
} from '@pertexo/core/identity';

import { canonicalJson } from '@pertexo/workflow-model';
import {
  applicationError,
  throwApplicationError,
} from '../../../platform/http/index.js';
import { federationSecretContext } from '../protocol/oidc.js';
import {
  validateSamlCertificates,
  samlTransportAvailable,
} from '../protocol/saml/configuration.js';
import { samlServiceProviderMetadata } from '../protocol/saml/gateway.js';
import type {
  FederationProviderCreate,
  FederationProviderUpdate,
  SamlConfiguration,
} from '@pertexo/contracts';
type Scope = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
}>;
type Command = Scope &
  Readonly<{ idempotencyKey: string; expectedRevision: number }>;
export class FederationManagementService {
  private readonly secret: string;
  private readonly publicOrigin: string;
  private readonly secureCookies: boolean;
  constructor(
    readonly store: FederationManagementStore,
    private readonly envelope: ApplicationSecretEnvelope | undefined,
    {
      secret,
      publicOrigin,
      secureCookies,
    }: Readonly<{
      secret: string;
      publicOrigin: string;
      secureCookies: boolean;
    }>,
  ) {
    this.secret = secret;
    this.publicOrigin = publicOrigin;
    this.secureCookies = secureCookies;
  }
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
  createProvider(command: Command & FederationProviderCreate) {
    const envelope = this.requireConfigured();
    if (command.kind === 'saml') {
      this.validateSaml(command.configuration);
      return this.store.createProvider(command);
    }
    const { clientSecret, ...input } = command;
    return this.store.createProvider({
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
    command: Command &
      FederationProviderUpdate &
      Readonly<{ providerId: string }>,
  ) {
    const envelope = this.requireConfigured();
    if ('kind' in command) {
      this.validateSaml(command.configuration);
      return this.store.updateProvider(command);
    }
    const { clientSecret, ...input } = command;
    return this.store.updateProvider({
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
  private requireSamlTransport() {
    if (
      !samlTransportAvailable(this.publicOrigin, {
        secureCookies: this.secureCookies,
      })
    )
      throwApplicationError(
        applicationError('request.invalid', {
          safeDetail:
            'SAML sign-in requires an HTTPS public app address and secure session cookies.',
        }),
      );
  }
  private validateSaml(configuration: SamlConfiguration) {
    this.requireSamlTransport();
    try {
      validateSamlCertificates(configuration);
    } catch {
      throwApplicationError(
        applicationError('request.invalid', {
          safeDetail:
            'Use one or two RSA certificates of at least 2,048 bits, including a currently valid certificate.',
        }),
      );
    }
  }
  async metadata(scope: Scope) {
    this.requireSamlTransport();
    const settings = await this.store.settings(scope);
    if (settings.organization === null)
      return throwApplicationError(applicationError('resource.not_found'));
    return samlServiceProviderMetadata(
      settings.organization.id,
      this.publicOrigin,
    );
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
}
