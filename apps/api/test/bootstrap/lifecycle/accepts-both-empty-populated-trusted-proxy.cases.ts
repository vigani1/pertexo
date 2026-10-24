import { expect, it, vi } from 'vitest';
import {
  createApiApplication,
  type ApiApplicationDependencies,
} from '../../../src/app.js';

import type { ApiConnectionRuntime } from '../../../src/platform/connections/runtime.module.js';

import { createStubApiWorkflowRuntime } from '../../support/api-platform.fixture.js';
import {
  config,
  dependencies,
  identityRuntime,
  betterAuthIdentityConfig,
  artifactRuntime,
  applicationFixture,
} from '../fixture.js';

export function registerAcceptsBothEmptyPopulatedTrustedProxy(): void {
  it('accepts both empty and populated trusted-proxy CIDR configuration', async () => {
    applicationFixture.application = await createApiApplication(
      { ...config, trustedProxyCidrs: [] },
      dependencies(),
    );
    await applicationFixture.application.close();
    applicationFixture.application = await createApiApplication(
      { ...config, trustedProxyCidrs: ['127.0.0.1/32'] },
      dependencies(),
    );
    expect(
      (
        await applicationFixture.application.inject({
          method: 'GET',
          url: '/health/live',
        })
      ).statusCode,
    ).toBe(200);
  });

  it.each([
    '/v1/workspaces/nonexistent',
    '/v1/workspaces/workspace-a/workflows/nonexistent/nested',
  ])('keeps an unknown feature-family route at 404: %s', async (url) => {
    applicationFixture.application = await createApiApplication(
      config,
      dependencies(),
    );
    await applicationFixture.application.init();

    const response = await applicationFixture.application.inject({
      method: 'GET',
      url,
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(response.json()).toMatchObject({
      status: 404,
      code: 'resource.not_found',
    });
  });

  it('rejects contradictory provided and create-time runtime dependencies', async () => {
    const selectedIdentityRuntime = identityRuntime();
    const selectedWorkflowRuntime = createStubApiWorkflowRuntime(
      selectedIdentityRuntime.dependencies.authorization,
    );
    const selectedConnectionRuntime = {
      dependencies: {},
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as ApiConnectionRuntime;
    const cases = [
      {
        dependencies: {
          ...dependencies(),
          artifactRuntime: artifactRuntime(),
          artifactOverrides: {},
        },
        message: 'artifact runtime cannot be provided with artifact overrides',
      },
      {
        dependencies: {
          ...dependencies(),
          identityRuntime: selectedIdentityRuntime,
          identityOverrides: { clock: { now: () => new Date(0) } },
        },
        message: 'identity runtime cannot be provided with identity overrides',
      },
      {
        dependencies: {
          ...dependencies(),
          workflowRuntime: selectedWorkflowRuntime,
          workflowOverrides: {},
        },
        message: 'workflow runtime cannot be provided with workflow overrides',
      },
      {
        dependencies: {
          ...dependencies(),
          connectionRuntime: selectedConnectionRuntime,
          connectionOverrides: {},
        },
        message:
          'connection runtime cannot be provided with connection overrides',
      },
    ];

    for (const selected of cases)
      await expect(
        createApiApplication(
          config,
          selected.dependencies as unknown as ApiApplicationDependencies,
        ),
      ).rejects.toThrow(selected.message);
  });

  it('rejects runtime overrides that cannot participate in composition', async () => {
    const cases = [
      {
        dependencies: {
          ...dependencies(),
          identityRuntime: identityRuntime(),
          artifactOverrides: {},
        },
        message:
          'artifact overrides require configured artifact runtime creation',
      },
      {
        dependencies: { ...dependencies(), artifactRuntime: artifactRuntime() },
        message: 'feature runtimes require an available identity runtime',
      },
      {
        dependencies: { ...dependencies(), identityOverrides: {} },
        message:
          'identity overrides require configured identity runtime creation',
      },
      {
        dependencies: { ...dependencies(), workflowOverrides: {} },
        message:
          'workflow overrides require available identity runtime creation',
      },
      {
        dependencies: {
          ...dependencies(),
          identityRuntime: identityRuntime(),
          connectionOverrides: {},
        },
        message:
          'connection overrides require configured connection runtime creation',
      },
      {
        dependencies: {
          ...dependencies(),
          workflowRuntime: createStubApiWorkflowRuntime(
            identityRuntime().dependencies.authorization,
          ),
        },
        message: 'feature runtimes require an available identity runtime',
      },
    ];

    for (const selected of cases)
      await expect(
        createApiApplication(
          config,
          selected.dependencies as unknown as ApiApplicationDependencies,
        ),
      ).rejects.toThrow(selected.message);
  });

  it('refuses configured connections without the application secret even with an injected identity runtime', async () => {
    const selectedIdentity = identityRuntime();
    const selectedWorkflow = createStubApiWorkflowRuntime(
      selectedIdentity.dependencies.authorization,
    );
    await expect(
      createApiApplication(
        {
          ...config,
          connections: { kmsKeyReference: 'test-key', region: 'test-region' },
        },
        {
          ...dependencies(),
          identityRuntime: selectedIdentity,
          workflowRuntime: selectedWorkflow,
        },
      ),
    ).rejects.toThrow('Connections require application identity configuration');
    expect(selectedIdentity.close).toHaveBeenCalledOnce();
    expect(selectedWorkflow.close).toHaveBeenCalledOnce();
  });

  it('closes already-created runtimes when a later runtime factory fails', async () => {
    const identityClose = vi.fn().mockResolvedValue(undefined);
    const workflowClose = vi.fn().mockResolvedValue(undefined);
    const selectedIdentity = identityRuntime(identityClose);
    const selectedWorkflow = createStubApiWorkflowRuntime(
      selectedIdentity.dependencies.authorization,
      workflowClose,
    );
    const constructionFailure = new Error('connection construction failed');
    const connectionOverrides = Object.defineProperty({}, 'persistence', {
      enumerable: true,
      get: () => {
        throw constructionFailure;
      },
    });

    await expect(
      createApiApplication(
        {
          ...config,
          identity: betterAuthIdentityConfig('https://app.example.test'),
          connections: { kmsKeyReference: 'test-key', region: 'test-region' },
        },
        {
          ...dependencies(),
          connectionOverrides,
          identityRuntime: selectedIdentity,
          workflowRuntime: selectedWorkflow,
        },
      ),
    ).rejects.toBe(constructionFailure);
    expect(identityClose).toHaveBeenCalledOnce();
    expect(workflowClose).toHaveBeenCalledOnce();
  });
}
