import {
  workflowTestPreparationSchema,
  workflowTestStartRequestSchema,
  workflowTestAcceptedSchema,
  workflowTestListSchema,
  workflowTestDetailSchema,
} from '@pertexo/contracts';
import type { WorkflowTestStore } from '@pertexo/core/previews';
import { authorizeWorkspaceOperation } from '../../authorization/index.js';
import type { WorkspaceAuthorizationSource } from '../../workspaces/ports.js';
import {
  authorizeWorkflowTesting,
  workflowTestScope,
  type WorkflowTestUseCaseInput,
} from './authorization.js';

type Input = WorkflowTestUseCaseInput;
export class WorkflowTestsUseCase {
  constructor(
    private readonly store: WorkflowTestStore,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}
  async prepare(input: Input) {
    await this.authorize(input);
    return workflowTestPreparationSchema.parse(
      await this.store.prepare(this.scope(input)),
    );
  }
  async list(input: Input) {
    await this.authorize(input);
    return workflowTestListSchema.parse(
      await this.store.list(this.scope(input)),
    );
  }
  async get(input: Input & { runId: string }) {
    await this.authorize(input);
    return workflowTestDetailSchema.parse(
      await this.store.get({ ...this.scope(input), runId: input.runId }),
    );
  }
  async start(input: Input & { request: unknown; idempotencyKey: string }) {
    await this.authorize(input);
    return workflowTestAcceptedSchema.parse(
      await this.store.start({
        ...this.scope(input),
        idempotencyKey: input.idempotencyKey,
        request: workflowTestStartRequestSchema.parse(input.request),
      }),
    );
  }
  async cancel(input: Input & { runId: string }) {
    await this.authorize(input);
    await authorizeWorkspaceOperation({
      access: this.authorization,
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      capability: 'run:cancel',
      allowedWorkspaceStatuses: ['active'],
      disclosure: 'not_found',
    });
    await this.store.cancel({ ...this.scope(input), runId: input.runId });
    return { canceled: true };
  }
  private scope(input: Input) {
    return workflowTestScope(input);
  }
  private authorize(input: Input) {
    return authorizeWorkflowTesting(this.authorization, input);
  }
}
