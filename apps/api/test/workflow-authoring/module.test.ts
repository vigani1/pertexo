import { describe, expect, it } from 'vitest';
import {
  CreateWorkflowUseCase,
  WorkflowAuthoringController,
  WorkflowAuthoringModule,
  type WorkflowAuthoringDependencies,
} from '../../src/workflow-authoring/index.js';

const dependencies = {
  persistence: {
    restoreWorkflowVersion: () => Promise.reject(new Error('not used')),
    transitionWorkflowLifecycle: () =>
      Promise.reject(new Error('not exercised')),
    createWorkflow: () => Promise.reject(new Error('not exercised')),
    listWorkflows: () => Promise.resolve({ items: [] }),
    getDraft: () => Promise.resolve(null),
    getVersion: () => Promise.resolve(null),
    listVersions: () => Promise.resolve({ items: [] }),
    saveDraft: () => Promise.reject(new Error('not exercised')),
    publishWorkflow: () => Promise.reject(new Error('not exercised')),
  },
  authorization: { findAccess: () => Promise.resolve(undefined) },
} satisfies WorkflowAuthoringDependencies;

// Nest dynamic modules require a class token.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class FakeIdentityModule {}

describe('workflow authoring Nest module', () => {
  it('registers each application use case through explicit narrow providers', () => {
    const dynamic = WorkflowAuthoringModule.register(dependencies, {
      module: FakeIdentityModule,
    });
    const providers = dynamic.providers ?? [];
    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provide: CreateWorkflowUseCase }),
      ]),
    );
    expect(dynamic.controllers).toContain(WorkflowAuthoringController);
  });
});
