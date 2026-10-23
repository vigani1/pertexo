import { expect, it } from 'vitest';
import { CreateWorkflowUseCase } from '../../../src/workflow-authoring/use-cases.js';

import {
  workspaceId,
  workflowId,
  graph,
  actor,
  authorization,
  persistence,
} from './fixture.js';

export function registerProjectsOneCreateCommandReturnedWorkflow(): void {
  it('projects one create command and its returned workflow plus empty draft', async () => {
    const store = persistence();
    const result = await new CreateWorkflowUseCase(
      store,
      authorization(),
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      request: { name: ' Operations ' },
      idempotencyKey: 'create-42',
    });
    expect(result.body).toMatchObject({
      workflow: { id: workflowId, name: 'Operations' },
      draft: { workflowId, revision: 1 },
    });
    expect(result.representationTag).toMatch(/^"draft\./u);
    expect(store.createWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        emptyGraph: graph,
        idempotencyKey: 'create-42',
      }),
    );
  });
}
