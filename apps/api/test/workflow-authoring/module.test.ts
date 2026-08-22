import { describe, expect, it } from 'vitest';
import { PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE } from '@pertexo/node-catalog';

import { NodeTestingController } from '../../src/node-testing/controller.js';
import {
  GetPreviewRunUseCase,
  TestWorkflowNodeUseCase,
} from '../../src/node-testing/use-case.js';
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
    expect(dynamic.controllers).not.toContain(NodeTestingController);
  });

  it('registers preview routes only when persistence and release are composed', () => {
    const dynamic = WorkflowAuthoringModule.register(
      {
        ...dependencies,
        nodeTestingPersistence: {
          getDraft: dependencies.persistence.getDraft,
          acceptPreview: () => Promise.reject(new Error('not exercised')),
          readPreview: () => Promise.resolve(null),
        },
        nodeTestingRelease: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
      },
      { module: FakeIdentityModule },
    );
    const providers = dynamic.providers ?? [];
    expect(dynamic.controllers).toContain(NodeTestingController);
    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provide: TestWorkflowNodeUseCase }),
        expect.objectContaining({ provide: GetPreviewRunUseCase }),
      ]),
    );
  });
});
