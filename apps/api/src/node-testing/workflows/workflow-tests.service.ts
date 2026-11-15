import type { WorkflowTestStore } from '@pertexo/core/previews';
import type { WorkspaceAuthorizationSource } from '../../workspaces/ports.js';
import {
  authorizeWorkflowTesting,
  workflowTestScope,
  type WorkflowTestServiceInput,
} from './authorization.js';
import type { WorkflowTestStartRequest } from '@pertexo/contracts';

type Input = WorkflowTestServiceInput;
export class WorkflowTestsService {
  constructor(
    private readonly store: WorkflowTestStore,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}
  async prepare(input: Input) {
    await authorizeWorkflowTesting(this.authorization, input);
    return await this.store.prepare(workflowTestScope(input));
  }
  async list(input: Input) {
    await authorizeWorkflowTesting(this.authorization, input);
    return await this.store.list(workflowTestScope(input));
  }
  async get(input: Input & { runId: string }) {
    await authorizeWorkflowTesting(this.authorization, input);
    return await this.store.get({
      ...workflowTestScope(input),
      runId: input.runId,
    });
  }
  async start(
    input: Input & {
      request: WorkflowTestStartRequest;
      idempotencyKey: string;
    },
  ) {
    await authorizeWorkflowTesting(this.authorization, input);
    return await this.store.start({
      ...workflowTestScope(input),
      idempotencyKey: input.idempotencyKey,
      request: input.request,
    });
  }
  /** Core decides who may stop this test: only it knows who started it. */
  async cancel(input: Input & { runId: string }) {
    await authorizeWorkflowTesting(this.authorization, input);
    await this.store.cancel({
      ...workflowTestScope(input),
      runId: input.runId,
    });
    return { canceled: true };
  }
}
