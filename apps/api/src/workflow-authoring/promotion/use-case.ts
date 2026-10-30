import {
  workflowPromotionSettingsSchema,
  workflowPromotionTargetSchema,
  workflowPromotionTargetResultSchema,
  workflowPromotionPageQuerySchema,
  workflowPromotionCandidatesSchema,
  workflowPromotionCandidatesQuerySchema,
  workflowPromotionHistorySchema,
  workflowPromotionPreviewRequestSchema,
  workflowPromotionPreviewSchema,
  workflowPromotionApplySchema,
  workflowPromotionResultSchema,
} from '@pertexo/contracts';
import type { WorkflowPromotionStore } from '@pertexo/database/authoring';
import {
  authorizeWorkspaceOperation,
  type WorkspaceAuthorizationSource,
  BROWSABLE_WORKSPACE_STATUSES,
  type WorkspaceStatus,
} from '../../authorization/index.js';
import type { WorkflowApplicationInput } from '../ports.js';
import { parseRequestBody } from '../../platform/http/index.js';

type Scope = WorkflowApplicationInput & {
  signal?: AbortSignal;
  traceparent?: string;
};
type Read = Scope & { request: unknown };
type Command = Read & { idempotencyKey: string };
export class WorkflowPromotionUseCase {
  constructor(
    private readonly store: WorkflowPromotionStore,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}
  async settings(input: Scope) {
    await this.authorizeRead(input);
    return workflowPromotionSettingsSchema.parse(
      await this.store.settings(this.scope(input)),
    );
  }
  async setTarget(input: Command) {
    await this.authorize(input, 'workspace:manage');
    const body = parseRequestBody(workflowPromotionTargetSchema, input.request);
    return workflowPromotionTargetResultSchema.parse(
      await this.store.setTarget({
        ...this.scope(input),
        ...body,
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }
  async candidates(input: Read) {
    await this.authorizeRead(input);
    const query = workflowPromotionCandidatesQuerySchema.parse(input.request);
    return workflowPromotionCandidatesSchema.parse(
      await this.store.candidates({ ...this.scope(input), ...query }),
    );
  }
  async history(input: Read) {
    await this.authorizeRead(input);
    const query = workflowPromotionPageQuerySchema.parse(input.request);
    return workflowPromotionHistorySchema.parse(
      await this.store.history({ ...this.scope(input), ...query }),
    );
  }
  async preview(input: Read) {
    await this.authorize(input, 'workflow:update');
    const body = parseRequestBody(
      workflowPromotionPreviewRequestSchema,
      input.request,
    );
    return workflowPromotionPreviewSchema.parse(
      await this.store.preview({ ...this.scope(input), ...body }),
    );
  }
  async apply(input: Command) {
    const body = parseRequestBody(workflowPromotionApplySchema, input.request);
    await this.authorize(
      input,
      body.mode === 'draft' ? 'workflow:update' : 'workflow:publish',
    );
    return workflowPromotionResultSchema.parse(
      await this.store.apply({
        ...this.scope(input),
        ...body,
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }
  private scope(input: Scope) {
    return {
      workspaceId: input.routeWorkspaceId,
      actorId: input.actor.actorId,
      requestId: input.actor.requestId,
      ...(input.actor.traceId === undefined
        ? {}
        : { traceId: input.actor.traceId }),
      ...(input.traceparent === undefined
        ? {}
        : { traceparent: input.traceparent }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
  }
  private authorizeRead(input: Scope) {
    return this.authorize(
      input,
      'workflow:update',
      BROWSABLE_WORKSPACE_STATUSES,
    );
  }
  private authorize(
    input: Scope,
    capability: 'workflow:update' | 'workflow:publish' | 'workspace:manage',
    allowedWorkspaceStatuses: readonly WorkspaceStatus[] = ['active'],
  ) {
    return authorizeWorkspaceOperation({
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      capability,
      access: this.authorization,
      disclosure: 'not_found',
      allowedWorkspaceStatuses,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.authorizedWorkspace === undefined
        ? {}
        : { authorizedWorkspace: input.authorizedWorkspace }),
    });
  }
}
