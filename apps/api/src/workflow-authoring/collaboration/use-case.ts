import {
  workflowCommentBodySchema,
  workflowCommentCreateSchema,
  workflowCommentEditSchema,
  workflowCommentDeleteSchema,
  workflowCommentStatusSchema,
  workflowCommentListQuerySchema,
  workflowCommentDetailQuerySchema,
  workflowPresenceHeartbeatSchema,
  workflowPresenceQuerySchema,
  workspacePeopleQuerySchema,
  workflowCommentListSchema,
  workflowCommentDetailSchema,
  workflowCommentCommandResultSchema,
  workflowPresenceSchema,
  workflowPresenceHeartbeatResultSchema,
  workspacePeoplePageSchema,
} from '@pertexo/contracts';
import type { WorkflowCollaborationStore } from '@pertexo/database/authoring';
import {
  authorizeWorkspaceOperation,
  type WorkspaceAuthorizationSource,
} from '../../authorization/index.js';
import type { WorkflowApplicationInput } from '../ports.js';
type Scope = WorkflowApplicationInput & {
  workflowId: string;
  signal?: AbortSignal;
};
type Thread = Scope & { threadId: string };
interface Command {
  request: unknown;
  idempotencyKey: string;
}
export class WorkflowCollaborationUseCase {
  constructor(
    private readonly store: WorkflowCollaborationStore,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}
  async list(input: Scope & { query: unknown }) {
    return workflowCommentListSchema.parse(
      await this.store.list({
        ...(await this.scope(input)),
        ...workflowCommentListQuerySchema.parse(input.query),
      }),
    );
  }
  async read(input: Thread & { query: unknown }) {
    return workflowCommentDetailSchema.parse(
      await this.store.read({
        ...(await this.scope(input)),
        threadId: input.threadId,
        ...workflowCommentDetailQuerySchema.parse(input.query),
      }),
    );
  }
  async people(input: Scope & { query: unknown }) {
    return workspacePeoplePageSchema.parse(
      await this.store.people({
        ...(await this.scope(input)),
        ...workspacePeopleQuerySchema.parse(input.query),
      }),
    );
  }
  async create(input: Scope & Command) {
    return workflowCommentCommandResultSchema.parse(
      await this.store.create({
        ...(await this.scope(input)),
        ...workflowCommentCreateSchema.parse(input.request),
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }
  async reply(input: Thread & Command) {
    return workflowCommentCommandResultSchema.parse(
      await this.store.reply({
        ...(await this.scope(input)),
        threadId: input.threadId,
        ...workflowCommentBodySchema.parse(input.request),
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }
  async edit(input: Thread & Command & { commentId: string }) {
    return workflowCommentCommandResultSchema.parse(
      await this.store.edit({
        ...(await this.scope(input)),
        threadId: input.threadId,
        commentId: input.commentId,
        ...workflowCommentEditSchema.parse(input.request),
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }
  async remove(input: Thread & Command & { commentId: string }) {
    return workflowCommentCommandResultSchema.parse(
      await this.store.remove({
        ...(await this.scope(input)),
        threadId: input.threadId,
        commentId: input.commentId,
        ...workflowCommentDeleteSchema.parse(input.request),
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }
  async setStatus(input: Thread & Command) {
    return workflowCommentCommandResultSchema.parse(
      await this.store.setStatus({
        ...(await this.scope(input)),
        threadId: input.threadId,
        ...workflowCommentStatusSchema.parse(input.request),
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }
  async presence(input: Scope & { query: unknown }) {
    return workflowPresenceSchema.parse(
      await this.store.presence({
        ...(await this.scope(input)),
        ...workflowPresenceQuerySchema.parse(input.query),
      }),
    );
  }
  async heartbeat(input: Scope & { tabId: string; request: unknown }) {
    return workflowPresenceHeartbeatResultSchema.parse(
      await this.store.heartbeat({
        ...(await this.scope(input)),
        tabId: input.tabId,
        ...workflowPresenceHeartbeatSchema.parse(input.request),
      }),
    );
  }
  async leave(input: Scope & { tabId: string }) {
    await this.store.leave({
      ...(await this.scope(input)),
      tabId: input.tabId,
    });
  }
  private async scope(input: Scope) {
    await authorizeWorkspaceOperation({
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      capability: 'workflow:read',
      access: this.authorization,
      disclosure: 'not_found',
      allowedWorkspaceStatuses: ['active'],
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
