import {
  publicationReviewRequestSchema,
  publicationReviewDecisionSchema,
  publicationReviewSchema,
  publicationReviewOverviewSchema,
  publicationReviewDetailSchema,
} from '@pertexo/contracts';
import type { PublicationReviewStore } from '@pertexo/core/authoring';
import {
  authorizeWorkspaceOperation,
  type WorkspaceAuthorizationSource,
  BROWSABLE_WORKSPACE_STATUSES,
} from '../../authorization/index.js';
import type { WorkflowApplicationInput } from '../ports.js';
import { parseRequestBody } from '../../platform/http/index.js';

type Scope = WorkflowApplicationInput & {
  signal?: AbortSignal;
  traceparent?: string;
};
type WorkflowInput = Scope & { workflowId: string };
type RequestInput = Scope & { reviewId: string };
export class PublicationReviewUseCase {
  constructor(
    private readonly store: PublicationReviewStore,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}
  async overview(input: WorkflowInput) {
    await this.authorize(input, 'workflow:read');
    return publicationReviewOverviewSchema.parse(
      await this.store.overview({
        ...this.scope(input),
        workflowId: input.workflowId,
      }),
    );
  }
  async read(input: RequestInput) {
    await this.authorize(input, 'workflow:read');
    return publicationReviewDetailSchema.parse(
      await this.store.read({ ...this.scope(input), reviewId: input.reviewId }),
    );
  }
  async request(
    input: WorkflowInput & {
      request: unknown;
      representationTag: string;
      idempotencyKey: string;
    },
  ) {
    await this.authorize(input, 'workflow:publish');
    const body = parseRequestBody(
      publicationReviewRequestSchema,
      input.request,
    );
    return publicationReviewSchema.parse(
      await this.store.request({
        ...this.scope(input),
        ...body,
        workflowId: input.workflowId,
        representationTag: input.representationTag,
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }
  async decide(
    input: RequestInput & { request: unknown; idempotencyKey: string },
  ) {
    await this.authorize(input, 'governance:manage');
    const body = parseRequestBody(
      publicationReviewDecisionSchema,
      input.request,
    );
    return publicationReviewSchema.parse(
      await this.store.decide({
        ...this.scope(input),
        ...body,
        reviewId: input.reviewId,
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }
  private scope(input: Scope) {
    return {
      workspaceId: input.routeWorkspaceId,
      actorId: input.actor.actorId,
      requestId: input.actor.requestId,
      ...(input.traceparent === undefined
        ? {}
        : { traceparent: input.traceparent }),
      ...(input.actor.traceId === undefined
        ? {}
        : { traceId: input.actor.traceId }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
  }
  private authorize(
    input: Scope,
    capability: 'workflow:read' | 'workflow:publish' | 'governance:manage',
  ) {
    return authorizeWorkspaceOperation({
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      capability,
      access: this.authorization,
      disclosure: 'not_found',
      allowedWorkspaceStatuses:
        capability === 'workflow:read'
          ? BROWSABLE_WORKSPACE_STATUSES
          : ['active'],
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.authorizedWorkspace === undefined
        ? {}
        : { authorizedWorkspace: input.authorizedWorkspace }),
    });
  }
}
