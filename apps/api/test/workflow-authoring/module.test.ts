import { describe, expect, it } from 'vitest';
import {
  CreateWorkflowUseCase,
  DuplicateWorkflowUseCase,
  RenameWorkflowUseCase,
  WorkflowAuthoringController,
  WorkflowAuthoringModule,
  type WorkflowAuthoringDependencies,
} from '../../src/workflow-authoring/index.js';
import { WORKFLOW_AUTHORING_AUTHORIZATION } from '../../src/workflow-authoring/tokens.js';
import { WorkflowConcurrencyController } from '../../src/workflow-authoring/settings/concurrency-controller.js';
import { WorkflowConcurrencyUseCase } from '../../src/workflow-authoring/settings/concurrency.js';
import { WorkflowInputCasesController } from '../../src/workflow-authoring/input-cases/controller.js';
import { WorkflowInputCasesUseCase } from '../../src/workflow-authoring/input-cases/use-case.js';

const dependencies = {
  persistence: {
    restoreWorkflowVersion: () => Promise.reject(new Error('not used')),
    duplicateWorkflow: () => Promise.reject(new Error('not used')),
    transitionWorkflowLifecycle: () =>
      Promise.reject(new Error('not exercised')),
    renameWorkflow: () => Promise.reject(new Error('not exercised')),
    createWorkflow: () => Promise.reject(new Error('not exercised')),
    listWorkflows: () => Promise.resolve({ items: [] }),
    getWorkflow: () => Promise.resolve(null),
    getDraft: () => Promise.resolve(null),
    validateDraft: () => Promise.resolve(null),
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
  it('registers owned input case commands without expanding existing authoring persistence', () => {
    expect(
      WorkflowAuthoringModule.register(dependencies, {
        module: FakeIdentityModule,
      }).controllers,
    ).not.toContain(WorkflowInputCasesController);
    const unused = () => Promise.reject(new Error('not exercised'));
    const dynamic = WorkflowAuthoringModule.register(
      {
        ...dependencies,
        inputCasePersistence: {
          listCases: unused,
          getCase: unused,
          createCase: unused,
          updateCase: unused,
          deleteCase: unused,
          close: () => Promise.resolve(),
        },
      },
      { module: FakeIdentityModule },
    );
    expect(dynamic.controllers).toContain(WorkflowInputCasesController);
    expect(dynamic.providers).toContainEqual(
      expect.objectContaining({ provide: WorkflowInputCasesUseCase }),
    );
  });
  it('registers concurrency controls only when the owned persistence is composed', () => {
    const unavailable = WorkflowAuthoringModule.register(dependencies, {
      module: FakeIdentityModule,
    });
    expect(unavailable.controllers).not.toContain(
      WorkflowConcurrencyController,
    );
    const dynamic = WorkflowAuthoringModule.register(
      {
        ...dependencies,
        concurrencyPersistence: {
          readSettings: () => Promise.reject(new Error('not exercised')),
          updateSettings: () => Promise.reject(new Error('not exercised')),
        },
      },
      { module: FakeIdentityModule },
    );
    expect(dynamic.controllers).toContain(WorkflowConcurrencyController);
    expect(dynamic.providers).toContainEqual(
      expect.objectContaining({ provide: WorkflowConcurrencyUseCase }),
    );
  });
  it('registers the creation use case and authoring controller', () => {
    const dynamic = WorkflowAuthoringModule.register(dependencies, {
      module: FakeIdentityModule,
    });
    const providers = dynamic.providers ?? [];
    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provide: CreateWorkflowUseCase }),
        expect.objectContaining({ provide: RenameWorkflowUseCase }),
        expect.objectContaining({ provide: DuplicateWorkflowUseCase }),
      ]),
    );
    expect(dynamic.exports).toContain(RenameWorkflowUseCase);
    expect(dynamic.exports).toContain(DuplicateWorkflowUseCase);
    expect(dynamic.controllers).toContain(WorkflowAuthoringController);
    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provide: WORKFLOW_AUTHORING_AUTHORIZATION }),
      ]),
    );
  });
});
