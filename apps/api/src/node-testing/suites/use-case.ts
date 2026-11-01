import {
  workflowTestSuitePreparationSchema,
  workflowTestSuiteStartRequestSchema,
  workflowTestSuiteAcceptedSchema,
  workflowTestSuiteListSchema,
  workflowTestSuiteDetailSchema,
  workflowTestSuiteCaseReportSchema,
} from '@pertexo/contracts';
import type { WorkflowTestSuiteStore } from '@pertexo/core/authoring';
import {
  authorizeWorkspaceOperation,
  type WorkspaceAuthorizationSource,
} from '../../authorization/index.js';
import {
  authorizeWorkflowTesting,
  workflowTestScope,
  type WorkflowTestUseCaseInput,
} from '../workflows/authorization.js';
export class WorkflowTestSuitesUseCase {
  constructor(
    private readonly store: WorkflowTestSuiteStore,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}
  async prepare(input: WorkflowTestUseCaseInput) {
    await authorizeWorkflowTesting(this.authorization, input);
    return workflowTestSuitePreparationSchema.parse(
      await this.store.prepare(workflowTestScope(input)),
    );
  }
  async list(input: WorkflowTestUseCaseInput) {
    await authorizeWorkflowTesting(this.authorization, input);
    return workflowTestSuiteListSchema.parse(
      await this.store.list(workflowTestScope(input)),
    );
  }
  async get(input: WorkflowTestUseCaseInput & { suiteId: string }) {
    await authorizeWorkflowTesting(this.authorization, input);
    return workflowTestSuiteDetailSchema.parse(
      await this.store.get({
        ...workflowTestScope(input),
        suiteId: input.suiteId,
      }),
    );
  }
  async report(
    input: WorkflowTestUseCaseInput & { suiteId: string; ordinal: number },
  ) {
    await authorizeWorkflowTesting(this.authorization, input);
    return workflowTestSuiteCaseReportSchema.parse(
      await this.store.report({
        ...workflowTestScope(input),
        suiteId: input.suiteId,
        ordinal: input.ordinal,
      }),
    );
  }
  async start(
    input: WorkflowTestUseCaseInput & {
      request: unknown;
      idempotencyKey: string;
    },
  ) {
    await authorizeWorkflowTesting(this.authorization, input);
    return workflowTestSuiteAcceptedSchema.parse(
      await this.store.start({
        ...workflowTestScope(input),
        request: workflowTestSuiteStartRequestSchema.parse(input.request),
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }
  async cancel(input: WorkflowTestUseCaseInput & { suiteId: string }) {
    await authorizeWorkflowTesting(this.authorization, input);
    await authorizeWorkspaceOperation({
      access: this.authorization,
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      capability: 'run:cancel',
      allowedWorkspaceStatuses: ['active'],
      disclosure: 'not_found',
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    await this.store.cancel({
      ...workflowTestScope(input),
      suiteId: input.suiteId,
    });
    return { canceled: true };
  }
}
