import { describe, expect, it } from 'vitest';

import {
  StartWorkflowRunUseCase,
  WorkflowRunsController,
  WorkflowRunsModule,
  type WorkflowRunsDependencies,
} from '../../src/workflow-runs/index.js';

const dependencies = {
  persistence: {
    start: () => Promise.reject(new Error('not exercised')),
    get: () => Promise.resolve(undefined),
    cancel: () => Promise.reject(new Error('not exercised')),
  },
  authorization: { findAccess: () => Promise.resolve(undefined) },
  streamer: {
    stream: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    }),
  },
} satisfies WorkflowRunsDependencies;

// Nest dynamic modules require a class token.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class FakeIdentityModule {}

describe('workflow runs Nest module', () => {
  it('registers the four behavior use cases and one thin controller', () => {
    const dynamic = WorkflowRunsModule.register(dependencies, {
      module: FakeIdentityModule,
    });
    expect(dynamic.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provide: StartWorkflowRunUseCase }),
      ]),
    );
    expect(dynamic.controllers).toEqual([WorkflowRunsController]);
  });
});
