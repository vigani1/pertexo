import { requestIdentifiers } from '../../workspaces/request/caller.js';
import type { z } from 'zod';
import type {
  workflowPromotionTargetSchema,
  workflowPromotionPageQuerySchema,
  workflowPromotionCandidatesQuerySchema,
  workflowPromotionPreviewRequestSchema,
  workflowPromotionApplySchema,
} from '@pertexo/contracts';
import type { WorkflowPromotionStore } from '@pertexo/core/authoring';
import {
  authorizeWorkspaceOperation,
  type WorkspaceAuthorizationSource,
  BROWSABLE_WORKSPACE_STATUSES,
  type WorkspaceStatus,
} from '../../authorization/index.js';
import type { WorkflowApplicationInput } from '../ports.js';
import { ACTIVE_WORKSPACE_STATUSES } from '@pertexo/policy';

type Scope = WorkflowApplicationInput & {
  signal?: AbortSignal;
  traceparent?: string;
};
type Read<Request> = Scope & { request: Request };
type Command<Request> = Read<Request> & { idempotencyKey: string };
type Of<Schema extends z.ZodType> = z.output<Schema>;
export class WorkflowPromotionService {
  constructor(
    private readonly store: WorkflowPromotionStore,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}
  async settings(input: Scope) {
    await this.authorizeRead(input);
    return await this.store.settings(this.scope(input));
  }
  async setTarget(input: Command<Of<typeof workflowPromotionTargetSchema>>) {
    await this.authorize(input, 'workspace:manage');
    const body = input.request;
    return await this.store.setTarget({
      ...this.scope(input),
      ...body,
      idempotencyKey: input.idempotencyKey,
    });
  }
  async candidates(
    input: Read<Of<typeof workflowPromotionCandidatesQuerySchema>>,
  ) {
    await this.authorizeRead(input);
    const query = input.request;
    return await this.store.candidates({ ...this.scope(input), ...query });
  }
  async history(input: Read<Of<typeof workflowPromotionPageQuerySchema>>) {
    await this.authorizeRead(input);
    const query = input.request;
    return await this.store.history({ ...this.scope(input), ...query });
  }
  async preview(input: Read<Of<typeof workflowPromotionPreviewRequestSchema>>) {
    await this.authorize(input, 'workflow:update');
    const body = input.request;
    return await this.store.preview({ ...this.scope(input), ...body });
  }
  async apply(input: Command<Of<typeof workflowPromotionApplySchema>>) {
    const body = input.request;
    await this.authorize(
      input,
      body.mode === 'draft' ? 'workflow:update' : 'workflow:publish',
    );
    return await this.store.apply({
      ...this.scope(input),
      ...body,
      idempotencyKey: input.idempotencyKey,
    });
  }
  private scope(input: Scope) {
    return {
      workspaceId: input.routeWorkspaceId,
      actorId: input.actor.actorId,
      ...requestIdentifiers(input.actor),
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
    allowedWorkspaceStatuses: readonly WorkspaceStatus[] = ACTIVE_WORKSPACE_STATUSES,
  ) {
    return authorizeWorkspaceOperation({
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      capability,
      access: this.authorization,
      disclosure: 'not_found',
      allowedWorkspaceStatuses,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.authorizedWorkspace?.capability !== capability
        ? {}
        : { authorizedWorkspace: input.authorizedWorkspace }),
    });
  }
}
