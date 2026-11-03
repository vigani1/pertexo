import type { z } from 'zod';
import { canonicalEmail } from '@pertexo/workflow-model';
import { randomUUID } from 'node:crypto';
import {
  applicationError,
  throwApplicationError,
} from '../../platform/http/application-error.js';

import {
  digestSha256Hex,
  encodeBase64Url,
  type IdentityCrypto,
} from '../../identity/index.js';
import type { ActorContext } from '../../authorization/index.js';
import {
  decodeWorkspaceInvitationCursor,
  encodeWorkspaceInvitationCursor,
} from '../cursor.js';
import type {
  IdentityWorkspacePersistence,
  InvitationTokenProtector,
  WorkspaceInvitationPersistenceRecord,
} from '../ports.js';
import type {
  workspaceInvitationCommandRequestSchema,
  workspaceInvitationCreateRequestSchema,
} from '../workspace-transport.js';
import {
  workspaceInvitationCommandResponseSchema,
  workspaceInvitationsResponseSchema,
  type WorkspaceInvitationCommandResponse,
  type WorkspaceInvitationsResponse,
} from '../workspace-transport.js';

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
    private readonly tokens: InvitationTokenProtector | undefined,
    private readonly crypto: IdentityCrypto,
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
      issuanceAvailable: this.tokens !== undefined,
      items: page.items.map(toResponse),
      nextCursor:
        page.nextCursor === undefined
          ? null
          : encodeWorkspaceInvitationCursor(page.nextCursor),
    });
  }

  public async create(
    input: InvitationCommandContext &
      Readonly<{
        request: z.output<typeof workspaceInvitationCreateRequestSchema>;
      }>,
  ): Promise<WorkspaceInvitationCommandResponse> {
    const { request } = input;
    const protector = this.requireTokenProtection();
    const invitationId = randomUUID();
    const deliveryAttemptId = randomUUID();
    const token = this.issueToken(input.routeWorkspaceId, invitationId);
    const result = await this.persistence.createWorkspaceInvitation({
      workspaceId: input.routeWorkspaceId,
      actorUserId: input.actor.actorId,
      invitationId,
      deliveryAttemptId,
      email: canonicalEmail(request.email),
      role: request.role,
      tokenDigest: digestSha256Hex(token.secret, this.crypto),
      sealedToken: await protector.seal(
        token.value,
        associatedData(input.routeWorkspaceId, invitationId, deliveryAttemptId),
      ),
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
    const { request } = input;
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
      const protector = this.requireTokenProtection();
      const deliveryAttemptId = randomUUID();
      const token = this.issueToken(input.routeWorkspaceId, input.invitationId);
      result = await this.persistence.resendWorkspaceInvitation({
        ...common,
        deliveryAttemptId,
        tokenDigest: digestSha256Hex(token.secret, this.crypto),
        sealedToken: await protector.seal(
          token.value,
          associatedData(
            input.routeWorkspaceId,
            input.invitationId,
            deliveryAttemptId,
          ),
        ),
      });
    }
    return workspaceInvitationCommandResponseSchema.parse({
      invitation: toResponse(result.invitation),
      replayed: result.replayed,
    });
  }

  private requireTokenProtection(): InvitationTokenProtector {
    if (this.tokens === undefined)
      return throwApplicationError(
        applicationError('workspace.invitation_not_configured'),
      );
    return this.tokens;
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
  Readonly<{
    invitationId: string;
    request: z.output<typeof workspaceInvitationCommandRequestSchema>;
  }>;

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
