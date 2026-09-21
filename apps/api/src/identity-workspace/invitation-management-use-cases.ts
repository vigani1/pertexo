import { randomUUID } from 'node:crypto';

import {
  digestSha256Hex,
  encodeBase64Url,
  type IdentityClock,
  type IdentityCrypto,
} from '../identity/index.js';
import type { ActorContext } from '../workspaces/index.js';
import {
  decodeWorkspaceInvitationCursor,
  encodeWorkspaceInvitationCursor,
} from './cursor.js';
import type {
  IdentityWorkspacePersistence,
  InvitationTokenProtector,
  WorkspaceInvitationPersistenceRecord,
} from './ports.js';
import {
  workspaceInvitationCommandRequestSchema,
  workspaceInvitationCommandResponseSchema,
  workspaceInvitationCreateRequestSchema,
  workspaceInvitationsResponseSchema,
  type WorkspaceInvitationCommandResponse,
  type WorkspaceInvitationsResponse,
} from './types.js';

const INVITATION_TTL_MILLIS = 7 * 24 * 60 * 60 * 1_000;

type InvitationPersistence = Required<
  Pick<
    IdentityWorkspacePersistence,
    | 'listWorkspaceInvitations'
    | 'createWorkspaceInvitation'
    | 'resendWorkspaceInvitation'
    | 'revokeWorkspaceInvitation'
  >
>;

export class WorkspaceInvitationManagementUseCase {
  public constructor(
    private readonly persistence: InvitationPersistence,
    private readonly tokens: InvitationTokenProtector,
    private readonly crypto: IdentityCrypto,
    private readonly clock: IdentityClock,
  ) {}

  public async list(
    input: Readonly<{
      actor: ActorContext;
      routeWorkspaceId: string;
      limit?: number;
      after?: string;
    }>,
  ): Promise<WorkspaceInvitationsResponse> {
    const page = await this.persistence.listWorkspaceInvitations(
      input.routeWorkspaceId,
      input.actor.actorId,
      {
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.after === undefined
          ? {}
          : { after: decodeWorkspaceInvitationCursor(input.after) }),
      },
    );
    return workspaceInvitationsResponseSchema.parse({
      items: page.items.map(toResponse),
      nextCursor:
        page.nextCursor === undefined
          ? null
          : encodeWorkspaceInvitationCursor(page.nextCursor),
    });
  }

  public async create(
    input: InvitationCommandContext & Readonly<{ request: unknown }>,
  ): Promise<WorkspaceInvitationCommandResponse> {
    const request = workspaceInvitationCreateRequestSchema.parse(input.request);
    const invitationId = randomUUID();
    const deliveryAttemptId = randomUUID();
    const token = this.issueToken(input.routeWorkspaceId, invitationId);
    const result = await this.persistence.createWorkspaceInvitation({
      workspaceId: input.routeWorkspaceId,
      actorUserId: input.actor.actorId,
      invitationId,
      deliveryAttemptId,
      email: request.email.normalize('NFKC').toLowerCase(),
      role: request.role,
      tokenDigest: digestSha256Hex(token.secret, this.crypto),
      sealedToken: await this.tokens.seal(
        token.value,
        associatedData(input.routeWorkspaceId, invitationId, deliveryAttemptId),
      ),
      expiresAt: new Date(this.clock.now().getTime() + INVITATION_TTL_MILLIS),
      idempotencyKey: input.idempotencyKey,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    });
    return workspaceInvitationCommandResponseSchema.parse({
      invitation: toResponse(result.invitation),
      replayed: result.replayed,
    });
  }

  public resend(
    input: InvitationChangeContext,
  ): Promise<WorkspaceInvitationCommandResponse> {
    return this.change(input, 'resend');
  }

  public revoke(
    input: InvitationChangeContext,
  ): Promise<WorkspaceInvitationCommandResponse> {
    return this.change(input, 'revoke');
  }

  private async change(
    input: InvitationChangeContext,
    operation: 'resend' | 'revoke',
  ): Promise<WorkspaceInvitationCommandResponse> {
    const request = workspaceInvitationCommandRequestSchema.parse(
      input.request,
    );
    const common = {
      workspaceId: input.routeWorkspaceId,
      actorUserId: input.actor.actorId,
      invitationId: input.invitationId,
      expectedRevision: request.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    };
    let result;
    if (operation === 'revoke') {
      result = await this.persistence.revokeWorkspaceInvitation(common);
    } else {
      const deliveryAttemptId = randomUUID();
      const token = this.issueToken(input.routeWorkspaceId, input.invitationId);
      result = await this.persistence.resendWorkspaceInvitation({
        ...common,
        deliveryAttemptId,
        tokenDigest: digestSha256Hex(token.secret, this.crypto),
        sealedToken: await this.tokens.seal(
          token.value,
          associatedData(
            input.routeWorkspaceId,
            input.invitationId,
            deliveryAttemptId,
          ),
        ),
        expiresAt: new Date(this.clock.now().getTime() + INVITATION_TTL_MILLIS),
      });
    }
    return workspaceInvitationCommandResponseSchema.parse({
      invitation: toResponse(result.invitation),
      replayed: result.replayed,
    });
  }

  private issueToken(workspaceId: string, invitationId: string) {
    const secret = encodeBase64Url(this.crypto.randomBytes(32));
    return Object.freeze({
      secret,
      value: `wi1.${workspaceId}.${invitationId}.${secret}`,
    });
  }
}

type InvitationCommandContext = Readonly<{
  actor: ActorContext;
  routeWorkspaceId: string;
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
}>;
type InvitationChangeContext = InvitationCommandContext &
  Readonly<{ invitationId: string; request: unknown }>;

function associatedData(
  workspaceId: string,
  invitationId: string,
  deliveryAttemptId: string,
): string {
  return `pertexo/workspace-invitation/${workspaceId}/${invitationId}/${deliveryAttemptId}`;
}

function toResponse(record: WorkspaceInvitationPersistenceRecord) {
  return {
    id: record.id,
    email: record.email,
    role: record.role,
    status: record.status,
    revision: record.revision,
    deliveryStatus: record.deliveryStatus,
    expiresAt: record.expiresAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
