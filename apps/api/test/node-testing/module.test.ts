import { PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE } from '@pertexo/node-catalog';
import { describe, expect, it } from 'vitest';

import { NodeTestingController } from '../../src/node-testing/controller.js';
import { NodeTestingModule } from '../../src/node-testing/module.js';
import {
  GetPreviewRunUseCase,
  TestWorkflowNodeUseCase,
} from '../../src/node-testing/use-case.js';

// Nest dynamic modules require a class token.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class FakeIdentityModule {}

describe('node testing Nest module', () => {
  it('owns preview routes and providers behind declared capabilities', () => {
    const dynamic = NodeTestingModule.register(
      {
        authorization: { findAccess: () => Promise.resolve(undefined) },
        persistence: {
          getDraft: () => Promise.resolve(null),
          acceptPreview: () => Promise.reject(new Error('not exercised')),
          readPreview: () => Promise.resolve(null),
        },
        release: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
      },
      { module: FakeIdentityModule },
    );
    const providers = dynamic.providers ?? [];
    expect(dynamic.controllers).toEqual([NodeTestingController]);
    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provide: TestWorkflowNodeUseCase }),
        expect.objectContaining({ provide: GetPreviewRunUseCase }),
      ]),
    );
  });
});
