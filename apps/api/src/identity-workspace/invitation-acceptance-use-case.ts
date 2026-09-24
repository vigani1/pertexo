import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { InvitationAcceptanceConflictError } from '@pertexo/database/api';

import {
  digestSha256Hex,
  encodeBase64Url,
  type IdentityClock,
  type IdentityCrypto,
  type OidcLoginResult,
  IdentityError,
} from '../identity/index.js';
import type { OidcLoginPort } from './use-cases.js';
import type {
  IdentitySessionAuthority,
  IdentityWorkspaceConfig,
  IdentityWorkspacePersistence,
  InvitationAcceptanceIntentPersistenceRecord,
} from './ports.js';
import {
  invitationAcceptanceCompleteRequestSchema,
  invitationAcceptanceJourneySchema,
  invitationAcceptanceReceiptSchema,
  invitationAcceptanceResolveRequestSchema,
  oidcStartResponseSchema,
  type InvitationAcceptanceJourney,
  type InvitationAcceptanceReceipt,
} from './types.js';

const INTENT_TTL_MILLIS = 15 * 60_000;
const DEFAULT_SESSION_TTL_MILLIS = 8 * 60 * 60_000;
const TOKEN_PATTERN =
  /^wi1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u;
const tokenSchema = z.string().regex(TOKEN_PATTERN);
const bindingSchema = z
  .string()
  .regex(
    /^wb1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/u,
  );

type AcceptancePersistence = Required<
  Pick<
    IdentityWorkspacePersistence,
    | 'resolveInvitationAcceptance'
    | 'readInvitationAcceptance'
    | 'recordInvitationAcceptanceProof'
    | 'completeInvitationAcceptance'
    | 'abandonInvitationAcceptance'
  >
>;

export class InvitationAcceptanceUseCase {
  public constructor(
    private readonly persistence: AcceptancePersistence,
    private readonly oidc: OidcLoginPort,
    private readonly crypto: IdentityCrypto,
    private readonly clock: IdentityClock,
    private readonly config: IdentityWorkspaceConfig,
    private readonly sessions: Pick<
      IdentitySessionAuthority,
      'replacementCredential'
    >,
  ) {}

  public async resolve(
    raw: unknown,
    priorBinding?: string,
  ): Promise<
    Readonly<{
      journey: InvitationAcceptanceJourney;
      binding?: string;
    }>
  > {
    const { token } = invitationAcceptanceResolveRequestSchema.parse(raw);
    const parsed = parseToken(token);
    if (parsed === null)
      return Object.freeze({ journey: { state: 'unavailable' as const } });
    const prior = parseBinding(priorBinding);
    const recoverySeed =
      prior === null
        ? undefined
        : [
            'pertexo-invitation-resolution-v1',
            parsed.workspaceId,
            parsed.invitationId,
            parsed.secret,
            prior.workspaceId,
            prior.intentId,
            prior.bindingSecret,
          ].join(':');
    const intentId =
      recoverySeed === undefined
        ? randomUUID()
        : deterministicUuid(`${recoverySeed}:intent`, this.crypto);
    const bindingSecret =
      recoverySeed === undefined
        ? encodeBase64Url(this.crypto.randomBytes(32))
        : encodeBase64Url(this.crypto.sha256(`${recoverySeed}:binding`));
    const csrfToken =
      recoverySeed === undefined
        ? encodeBase64Url(this.crypto.randomBytes(32))
        : encodeBase64Url(this.crypto.sha256(`${recoverySeed}:csrf`));
    const binding = `wb1.${parsed.workspaceId}.${intentId}.${bindingSecret}.${csrfToken}`;
    const intent = await this.persistence.resolveInvitationAcceptance({
      workspaceId: parsed.workspaceId,
      invitationId: parsed.invitationId,
      tokenDigest: digestSha256Hex(parsed.secret, this.crypto),
      intentId,
      bindingDigest: digestSha256Hex(bindingSecret, this.crypto),
      csrfDigest: digestSha256Hex(csrfToken, this.crypto),
      expiresAt: new Date(this.clock.now().getTime() + INTENT_TTL_MILLIS),
      ...(prior === null
        ? {}
        : {
            priorBinding: {
              workspaceId: prior.workspaceId,
              intentId: prior.intentId,
              bindingDigest: digestSha256Hex(prior.bindingSecret, this.crypto),
            },
          }),
    });
    if (intent === null)
      return Object.freeze({ journey: { state: 'unavailable' as const } });
    return Object.freeze({
      binding,
      journey: journey(intent, csrfToken, undefined, this.clock.now()),
    });
  }

  public async read(
    binding: string | undefined,
    authenticatedUserId?: string,
  ): Promise<InvitationAcceptanceJourney> {
    const selected = parseBinding(binding);
    if (selected === null) return { state: 'unavailable' };
    const intent = await this.persistence.readInvitationAcceptance(
      selected.workspaceId,
      digestSha256Hex(selected.bindingSecret, this.crypto),
    );
    return intent === null
      ? { state: 'unavailable' }
      : journey(
          intent,
          selected.csrfToken,
          authenticatedUserId,
          this.clock.now(),
        );
  }

  public async startOidc(
    binding: string | undefined,
    csrfToken: string | undefined,
  ) {
    const selected = await this.requireBoundJourney(binding, csrfToken);
    const result = await this.oidc.startLogin({
      kind: 'invitation_acceptance',
      workspaceId: selected.workspaceId,
      intentId: selected.intentId,
      bindingDigest: digestSha256Hex(selected.bindingSecret, this.crypto),
    });
    return Object.freeze({
      response: oidcStartResponseSchema.parse({
        authorizationUrl: result.authorizationUrl,
        expiresAt: result.expiresAt.toISOString(),
      }),
      oidcBinding: result.browserBinding,
      oidcBindingExpiresAt: result.expiresAt,
      oidcBindingMaxAgeSeconds: result.browserBindingMaxAgeSeconds,
    });
  }

  public async recordProof(result: OidcLoginResult): Promise<void> {
    const continuation = result.continuation;
    if (continuation?.kind !== 'invitation_acceptance') return;
    if (result.verifiedProfile.emailVerified !== true)
      throw new IdentityError('identity.callback_rejected');
    const recorded = await this.persistence.recordInvitationAcceptanceProof({
      workspaceId: continuation.workspaceId,
      intentId: continuation.intentId,
      bindingDigest: continuation.bindingDigest,
      userId: result.internalIdentity.userId,
      verifiedEmail: result.verifiedProfile.email,
      verifiedAt: this.clock.now(),
    });
    if (recorded === null)
      throw new InvitationAcceptanceConflictError(
        'unavailable',
        'Invitation acceptance is unavailable',
      );
  }

  public async complete(
    input: Readonly<{
      binding: string | undefined;
      csrfToken: string | undefined;
      authenticatedUserId: string;
      request: unknown;
      idempotencyKey: string;
      userAgent?: string;
      ipAddress?: string;
      requestId?: string;
      traceId?: string;
    }>,
  ): Promise<
    Readonly<{
      receipt: InvitationAcceptanceReceipt;
      replacementToken?: string;
      replacementExpiresAt?: Date;
    }>
  > {
    const selected = await this.requireBoundJourney(
      input.binding,
      input.csrfToken,
    );
    const request = invitationAcceptanceCompleteRequestSchema.parse(
      input.request,
    );
    if (request.intentId !== selected.intentId)
      throw new InvitationAcceptanceConflictError(
        'unavailable',
        'Invitation acceptance is unavailable',
      );
    const rawToken = encodeBase64Url(this.crypto.randomBytes(32));
    const expiresAt = new Date(
      this.clock.now().getTime() +
        (this.config.session?.ttlMillis ?? DEFAULT_SESSION_TTL_MILLIS),
    );
    const result = await this.persistence.completeInvitationAcceptance({
      workspaceId: selected.workspaceId,
      intentId: selected.intentId,
      invitationRevision: request.expectedRevision,
      actorUserId: input.authenticatedUserId,
      idempotencyKey: input.idempotencyKey,
      // The replacement must live in the store of the active session
      // authority, or the rotated browser would be signed out.
      replacementSession: {
        id: randomUUID(),
        ...this.sessions.replacementCredential(rawToken),
        expiresAt,
        ...(input.userAgent === undefined
          ? {}
          : { userAgent: input.userAgent }),
        ...(input.ipAddress === undefined
          ? {}
          : { ipAddress: input.ipAddress }),
      },
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    });
    const receipt = invitationAcceptanceReceiptSchema.parse({
      intentId: result.intentId,
      workspaceId: result.workspaceId,
      role: result.role,
      membershipCreated: result.membershipCreated,
      replayed: result.replayed,
    });
    return Object.freeze({
      receipt,
      ...(result.replacementSessionCreated
        ? { replacementToken: rawToken, replacementExpiresAt: expiresAt }
        : {}),
    });
  }

  public async abandon(
    binding: string | undefined,
    csrfToken: string | undefined,
  ): Promise<void> {
    const selected = parseBinding(binding);
    if (selected === null) return;
    this.verifyCsrf(selected.csrfToken, csrfToken);
    await this.persistence.abandonInvitationAcceptance(
      selected.workspaceId,
      selected.intentId,
      digestSha256Hex(selected.bindingSecret, this.crypto),
    );
  }

  private async requireBoundJourney(
    binding: string | undefined,
    csrfToken: string | undefined,
  ) {
    const selected = parseBinding(binding);
    if (selected === null)
      throw new InvitationAcceptanceConflictError(
        'unavailable',
        'Invitation acceptance is unavailable',
      );
    this.verifyCsrf(selected.csrfToken, csrfToken);
    const intent = await this.persistence.readInvitationAcceptance(
      selected.workspaceId,
      digestSha256Hex(selected.bindingSecret, this.crypto),
    );
    if (
      intent?.id !== selected.intentId ||
      intent.expiresAt.getTime() <= this.clock.now().getTime() ||
      intent.status === 'abandoned' ||
      intent.status === 'superseded' ||
      (intent.status !== 'completed' && intent.invitationStatus !== 'pending')
    )
      throw new InvitationAcceptanceConflictError(
        'unavailable',
        'Invitation acceptance is unavailable',
      );
    return selected;
  }

  private verifyCsrf(expected: string, supplied: string | undefined) {
    if (
      supplied === undefined ||
      !this.crypto.timingSafeEqual(
        Buffer.from(expected, 'utf8'),
        Buffer.from(supplied, 'utf8'),
      )
    )
      throw new IdentityError('identity.csrf_failed');
  }
}

function parseToken(value: string) {
  const match = tokenSchema.safeParse(value);
  if (!match.success) return null;
  const [, workspaceId, invitationId, secret] = TOKEN_PATTERN.exec(value) ?? [];
  return workspaceId === undefined ||
    invitationId === undefined ||
    secret === undefined
    ? null
    : { workspaceId, invitationId, secret };
}

function parseBinding(value: string | undefined) {
  if (value === undefined || !bindingSchema.safeParse(value).success)
    return null;
  const match = /^wb1\.([^.]+)\.([^.]+)\.([^.]+)\.([^.]+)$/u.exec(value);
  if (match === null) return null;
  const [, workspaceId, intentId, bindingSecret, csrfToken] = match;
  if (
    workspaceId === undefined ||
    intentId === undefined ||
    bindingSecret === undefined ||
    csrfToken === undefined
  )
    return null;
  return {
    workspaceId,
    intentId,
    bindingSecret,
    csrfToken,
  };
}

function journey(
  intent: InvitationAcceptanceIntentPersistenceRecord,
  csrfToken: string,
  authenticatedUserId?: string,
  now: Date = new Date(),
): InvitationAcceptanceJourney {
  const base = {
    intentId: intent.id,
    expiresAt: intent.expiresAt.toISOString(),
    csrfToken,
  };
  if (intent.expiresAt.getTime() <= now.getTime())
    return invitationAcceptanceJourneySchema.parse({
      ...base,
      state: 'expired',
    });
  if (intent.status === 'superseded')
    return invitationAcceptanceJourneySchema.parse({
      ...base,
      state: 'superseded',
    });
  if (intent.status === 'abandoned') return { state: 'unavailable' };
  if (intent.invitationStatus === 'revoked')
    return invitationAcceptanceJourneySchema.parse({
      ...base,
      state: 'revoked',
    });
  if (intent.invitationStatus === 'expired')
    return invitationAcceptanceJourneySchema.parse({
      ...base,
      state: 'expired',
    });
  if (intent.status === 'wrong_account')
    return invitationAcceptanceJourneySchema.parse({
      ...base,
      state: 'wrong_account',
    });
  if (intent.status === 'completed') {
    if (intent.receipt === null || intent.workspaceName === null)
      return { state: 'unavailable' };
    if (authenticatedUserId === undefined)
      return invitationAcceptanceJourneySchema.parse({
        ...base,
        state: 'sign_in_required',
      });
    if (authenticatedUserId !== intent.acceptedUserId)
      return invitationAcceptanceJourneySchema.parse({
        ...base,
        state: 'wrong_account',
      });
    return invitationAcceptanceJourneySchema.parse({
      ...base,
      state: 'completed',
      workspace: { id: intent.workspaceId, name: intent.workspaceName },
      role: intent.receipt.role,
      membershipCreated: intent.receipt.membershipCreated,
    });
  }
  if (
    intent.status === 'verified' &&
    intent.workspaceName !== null &&
    intent.invitationRole !== null &&
    authenticatedUserId === intent.verifiedUserId
  )
    return invitationAcceptanceJourneySchema.parse({
      ...base,
      state: 'ready',
      workspace: { id: intent.workspaceId, name: intent.workspaceName },
      role: intent.invitationRole,
      invitationRevision: intent.invitationRevision,
      sessionRotationRequired: true,
    });
  return invitationAcceptanceJourneySchema.parse({
    ...base,
    state: 'sign_in_required',
  });
}

function deterministicUuid(value: string, crypto: IdentityCrypto): string {
  const bytes = Uint8Array.from(crypto.sha256(value).slice(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
