import type {
  workflowCommentBodySchema,
  workflowCommentCreateSchema,
  workflowCommentDeleteSchema,
  workflowCommentDetailQuerySchema,
  workflowCommentEditSchema,
  workflowCommentListQuerySchema,
  workflowCommentStatusSchema,
  workflowPresenceHeartbeatSchema,
  workflowPresenceQuerySchema,
  workspacePeopleQuerySchema,
} from '@pertexo/contracts';
import {
  workflowCommentCommandResultSchema,
  workflowCommentDetailSchema,
  workflowCommentListSchema,
  workflowPresenceHeartbeatResultSchema,
  workflowPresenceSchema,
  workspacePeoplePageSchema,
} from '@pertexo/contracts';
import type { WorkflowCollaborationStore } from '@pertexo/core/authoring';
import type { z } from 'zod';
import {
  authorizeWorkspaceOperation,
  BROWSABLE_WORKSPACE_STATUSES,
  type WorkspaceAuthorizationSource,
  type WorkspaceStatus,
} from '../../authorization/index.js';
import type { WorkflowApplicationInput } from '../ports.js';
type Scope = WorkflowApplicationInput & {
  workflowId: string;
  signal?: AbortSignal;
};
type Thread = Scope & { threadId: string };
interface Command<Request> {
  request: Request;
  idempotencyKey: string;
}
export class WorkflowCollaborationUseCase {
  constructor(
    private readonly store: WorkflowCollaborationStore,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}
  async list(
    input: Scope & { query: z.output<typeof workflowCommentListQuerySchema> },
  ) {
    return workflowCommentListSchema.parse(
      await this.store.list({
        ...(await this.scope(input, BROWSABLE_WORKSPACE_STATUSES)),
        ...input.query,
      }),
    );
  }
  async read(
    input: Thread & {
      query: z.output<typeof workflowCommentDetailQuerySchema>;
    },
  ) {
    return workflowCommentDetailSchema.parse(
      await this.store.read({
        ...(await this.scope(input, BROWSABLE_WORKSPACE_STATUSES)),
        threadId: input.threadId,
        ...input.query,
      }),
    );
  }
  async people(
    input: Scope & { query: z.output<typeof workspacePeopleQuerySchema> },
  ) {
    return workspacePeoplePageSchema.parse(
      await this.store.people({
        ...(await this.scope(input, BROWSABLE_WORKSPACE_STATUSES)),
        ...input.query,
      }),
    );
  }
  async create(
    input: Scope & Command<z.output<typeof workflowCommentCreateSchema>>,
  ) {
    return workflowCommentCommandResultSchema.parse(
      await this.store.create({
        ...(await this.scope(input)),
        ...input.request,
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }
  async reply(
    input: Thread & Command<z.output<typeof workflowCommentBodySchema>>,
  ) {
    return workflowCommentCommandResultSchema.parse(
      await this.store.reply({
        ...(await this.scope(input)),
        threadId: input.threadId,
        ...input.request,
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }
  async edit(
    input: Thread &
      Command<z.output<typeof workflowCommentEditSchema>> & {
        commentId: string;
      },
  ) {
    return workflowCommentCommandResultSchema.parse(
      await this.store.edit({
        ...(await this.scope(input)),
        threadId: input.threadId,
        commentId: input.commentId,
        ...input.request,
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }
  async remove(
    input: Thread &
      Command<z.output<typeof workflowCommentDeleteSchema>> & {
        commentId: string;
      },
  ) {
    return workflowCommentCommandResultSchema.parse(
      await this.store.remove({
        ...(await this.scope(input)),
        threadId: input.threadId,
        commentId: input.commentId,
        ...input.request,
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }
  async setStatus(
    input: Thread & Command<z.output<typeof workflowCommentStatusSchema>>,
  ) {
    return workflowCommentCommandResultSchema.parse(
      await this.store.setStatus({
        ...(await this.scope(input)),
        threadId: input.threadId,
        ...input.request,
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }
  async presence(
    input: Scope & { query: z.output<typeof workflowPresenceQuerySchema> },
  ) {
    return workflowPresenceSchema.parse(
      await this.store.presence({
        ...(await this.scope(input, BROWSABLE_WORKSPACE_STATUSES)),
        ...input.query,
      }),
    );
  }
  async heartbeat(
    input: Scope & {
      tabId: string;
      request: z.output<typeof workflowPresenceHeartbeatSchema>;
    },
  ) {
    return workflowPresenceHeartbeatResultSchema.parse(
      await this.store.heartbeat({
        ...(await this.scope(input)),
        tabId: input.tabId,
        ...input.request,
      }),
    );
  }
  async leave(input: Scope & { tabId: string }) {
    await this.store.leave({
      ...(await this.scope(input)),
      tabId: input.tabId,
    });
  }
  private async scope(
    input: Scope,
    allowedWorkspaceStatuses: readonly WorkspaceStatus[] = ['active'],
  ) {
    await authorizeWorkspaceOperation({
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      capability: 'workflow:read',
      access: this.authorization,
      disclosure: 'not_found',
      allowedWorkspaceStatuses,
      ...(input.authorizedWorkspace === undefined
        ? {}
        : { authorizedWorkspace: input.authorizedWorkspace }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return {
      workspaceId: input.routeWorkspaceId,
      workflowId: input.workflowId,
      actorId: input.actor.actorId,
      requestId: input.actor.requestId,
      ...(input.actor.traceId === undefined
        ? {}
        : { traceId: input.actor.traceId }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
  }
}
