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
  BROWSABLE_WORKSPACE_STATUSES,
  type WorkspaceStatus,
  type WorkspaceAuthorizationSource,
} from '../../authorization/index.js';
import type { WorkflowApplicationInput } from '../ports.js';
import { parseRequestBody } from '../../platform/http/index.js';
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
        ...(await this.scope(input, BROWSABLE_WORKSPACE_STATUSES)),
        ...workflowCommentListQuerySchema.parse(input.query),
      }),
    );
  }
  async read(input: Thread & { query: unknown }) {
    return workflowCommentDetailSchema.parse(
      await this.store.read({
        ...(await this.scope(input, BROWSABLE_WORKSPACE_STATUSES)),
        threadId: input.threadId,
        ...workflowCommentDetailQuerySchema.parse(input.query),
      }),
    );
  }
  async people(input: Scope & { query: unknown }) {
    return workspacePeoplePageSchema.parse(
      await this.store.people({
        ...(await this.scope(input, BROWSABLE_WORKSPACE_STATUSES)),
        ...workspacePeopleQuerySchema.parse(input.query),
      }),
    );
  }
  async create(input: Scope & Command) {
    return workflowCommentCommandResultSchema.parse(
      await this.store.create({
        ...(await this.scope(input)),
        ...parseRequestBody(workflowCommentCreateSchema, input.request),
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }
  async reply(input: Thread & Command) {
    return workflowCommentCommandResultSchema.parse(
      await this.store.reply({
        ...(await this.scope(input)),
        threadId: input.threadId,
        ...parseRequestBody(workflowCommentBodySchema, input.request),
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
        ...parseRequestBody(workflowCommentEditSchema, input.request),
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
        ...parseRequestBody(workflowCommentDeleteSchema, input.request),
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }
  async setStatus(input: Thread & Command) {
    return workflowCommentCommandResultSchema.parse(
      await this.store.setStatus({
        ...(await this.scope(input)),
        threadId: input.threadId,
        ...parseRequestBody(workflowCommentStatusSchema, input.request),
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }
  async presence(input: Scope & { query: unknown }) {
    return workflowPresenceSchema.parse(
      await this.store.presence({
        ...(await this.scope(input, BROWSABLE_WORKSPACE_STATUSES)),
        ...workflowPresenceQuerySchema.parse(input.query),
      }),
    );
  }
  async heartbeat(input: Scope & { tabId: string; request: unknown }) {
    return workflowPresenceHeartbeatResultSchema.parse(
      await this.store.heartbeat({
        ...(await this.scope(input)),
        tabId: input.tabId,
        ...parseRequestBody(workflowPresenceHeartbeatSchema, input.request),
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
