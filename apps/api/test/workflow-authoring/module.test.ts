import { describe, expect, it } from 'vitest';

import {
  CreateWorkflowUseCase,
  WorkflowAuthoringController,
  WorkflowAuthoringModule,
  type WorkflowAuthoringDependencies,
} from '../../src/workflow-authoring/index.js';

const dependencies = {
  persistence: {
    createWorkflow: () => Promise.reject(new Error('not exercised')),
    listWorkflows: () => Promise.resolve({ items: [] }),
    getDraft: () => Promise.resolve(null),
    getVersion: () => Promise.resolve(null),
    listVersions: () => Promise.resolve({ items: [] }),
    saveDraft: () => Promise.reject(new Error('not exercised')),
    publishWorkflow: () => Promise.reject(new Error('not exercised')),
  },
  authorization: { findAccess: () => Promise.resolve(undefined) },
  sessionAuthenticationGuard: { canActivate: () => true } as never,
  csrfProtectionGuard: { canActivate: () => true } as never,
} satisfies WorkflowAuthoringDependencies;

describe('workflow authoring Nest module', () => {
  it('registers each application use case through explicit narrow providers', () => {
    const dynamic = WorkflowAuthoringModule.register(dependencies);
    const providers = dynamic.providers ?? [];
    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provide: CreateWorkflowUseCase }),
      ]),
    );
    expect(dynamic.controllers).toContain(WorkflowAuthoringController);
  });
});
