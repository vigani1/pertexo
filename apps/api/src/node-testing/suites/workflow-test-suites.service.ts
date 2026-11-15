import {
  workflowTestSuitePreparationSchema,
  workflowTestSuiteAcceptedSchema,
  workflowTestSuiteListSchema,
  workflowTestSuiteDetailSchema,
  workflowTestSuiteCaseReportSchema,
} from '@pertexo/contracts';
import type { WorkflowTestSuiteStore } from '@pertexo/core/previews';
import type { WorkspaceAuthorizationSource } from '../../authorization/index.js';
import {
  authorizeWorkflowTesting,
  workflowTestScope,
  type WorkflowTestServiceInput,
} from '../workflows/authorization.js';
import type { WorkflowTestSuiteStartRequest } from '@pertexo/contracts';
export class WorkflowTestSuitesService {
  constructor(
    private readonly store: WorkflowTestSuiteStore,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}
  async prepare(input: WorkflowTestServiceInput) {
    await authorizeWorkflowTesting(this.authorization, input);
    return workflowTestSuitePreparationSchema.parse(
      await this.store.prepare(workflowTestScope(input)),
    );
  }
  async list(input: WorkflowTestServiceInput) {
    await authorizeWorkflowTesting(this.authorization, input);
    return workflowTestSuiteListSchema.parse(
      await this.store.list(workflowTestScope(input)),
    );
  }
  async get(input: WorkflowTestServiceInput & { suiteId: string }) {
    await authorizeWorkflowTesting(this.authorization, input);
    return workflowTestSuiteDetailSchema.parse(
      await this.store.get({
        ...workflowTestScope(input),
        suiteId: input.suiteId,
      }),
    );
  }
  async report(
    input: WorkflowTestServiceInput & { suiteId: string; ordinal: number },
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
    input: WorkflowTestServiceInput & {
      request: WorkflowTestSuiteStartRequest;
      idempotencyKey: string;
    },
  ) {
    await authorizeWorkflowTesting(this.authorization, input);
    return workflowTestSuiteAcceptedSchema.parse(
      await this.store.start({
        ...workflowTestScope(input),
        request: input.request,
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }
  /** Core decides who may stop this suite: only it knows who started it. */
  async cancel(input: WorkflowTestServiceInput & { suiteId: string }) {
    await authorizeWorkflowTesting(this.authorization, input);
    await this.store.cancel({
      ...workflowTestScope(input),
      suiteId: input.suiteId,
    });
    return { canceled: true };
  }
}
