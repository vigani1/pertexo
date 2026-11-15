import { requestIdentifiers } from '../../workspaces/request/caller.js';
import { authorizeAuthoringOperation } from '../commands/authorization.js';
import type { z } from 'zod';
import type {
  publicationReviewRequestSchema,
  publicationReviewDecisionSchema,
} from '@pertexo/contracts';
import type { PublicationReviewStore } from '@pertexo/core/authoring';
import type { WorkspaceAuthorizationSource } from '../../authorization/index.js';
import type { WorkflowApplicationInput } from '../ports.js';

type Scope = WorkflowApplicationInput & {
  signal?: AbortSignal;
  traceparent?: string;
};
type WorkflowInput = Scope & { workflowId: string };
type RequestInput = Scope & { reviewId: string };
export class PublicationReviewService {
  constructor(
    private readonly store: PublicationReviewStore,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}
  async overview(input: WorkflowInput) {
    await authorizeAuthoringOperation(
      input,
      'workflow:read',
      this.authorization,
    );
    return await this.store.overview({
      ...this.scope(input),
      workflowId: input.workflowId,
    });
  }
  async read(input: RequestInput) {
    await authorizeAuthoringOperation(
      input,
      'workflow:read',
      this.authorization,
    );
    return await this.store.read({
      ...this.scope(input),
      reviewId: input.reviewId,
    });
  }
  async request(
    input: WorkflowInput & {
      request: z.output<typeof publicationReviewRequestSchema>;
      representationTag: string;
      idempotencyKey: string;
    },
  ) {
    await authorizeAuthoringOperation(
      input,
      'workflow:publish',
      this.authorization,
    );
    const body = input.request;
    return await this.store.request({
      ...this.scope(input),
      ...body,
      workflowId: input.workflowId,
      representationTag: input.representationTag,
      idempotencyKey: input.idempotencyKey,
    });
  }
  async decide(
    input: RequestInput & {
      request: z.output<typeof publicationReviewDecisionSchema>;
      idempotencyKey: string;
    },
  ) {
    await authorizeAuthoringOperation(
      input,
      'governance:manage',
      this.authorization,
    );
    const body = input.request;
    return await this.store.decide({
      ...this.scope(input),
      ...body,
      reviewId: input.reviewId,
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
}
