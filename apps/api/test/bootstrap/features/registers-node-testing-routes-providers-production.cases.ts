import type { WorkspaceDatabase } from '@pertexo/database/testing';

import { expect, it, vi } from 'vitest';
import { createTestApiApplication } from '../../support/api-application.js';

import {
  GetPreviewRunUseCase,
  TestWorkflowNodeUseCase,
} from '../../../src/node-testing/use-case.js';

import { createStubApiWorkflowRuntime } from '../../support/api-platform.fixture.js';
import {
  config,
  database,
  dependencies,
  identityRuntime,
  betterAuthIdentityConfig,
  betterAuthIdentityRuntime,
  nodeTestingWorkflowRuntime,
  workflowAuthoringDatabase,
  applicationFixture,
} from '../fixture.js';

export function registerRegistersNodeTestingRoutesProvidersProduction(): void {
  it('registers node-testing routes and providers from the workflow runtime', async () => {
    const selectedIdentityRuntime = identityRuntime();
    applicationFixture.application = await createTestApiApplication(config, {
      ...dependencies(),
      identityRuntime: selectedIdentityRuntime,
      workflowRuntime: nodeTestingWorkflowRuntime(
        selectedIdentityRuntime.dependencies.authorization,
        workflowAuthoringDatabase(),
      ),
    });
    await applicationFixture.application.init();

    expect(
      applicationFixture.application.get(TestWorkflowNodeUseCase),
    ).toBeInstanceOf(TestWorkflowNodeUseCase);
    expect(
      applicationFixture.application.get(GetPreviewRunUseCase),
    ).toBeInstanceOf(GetPreviewRunUseCase);

    const testResponse = await applicationFixture.application.inject({
      method: 'POST',
      url: '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/workflows/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/draft/nodes/cccccccc-cccc-4ccc-8ccc-cccccccccccc/test',
      payload: { mode: 'validate' },
    });
    expect(testResponse.statusCode).toBe(401);

    const previewResponse = await applicationFixture.application.inject({
      method: 'GET',
      url: '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/previews/dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    });
    expect(previewResponse.statusCode).toBe(401);
  });

  it('rejects deeply nested authenticated node-test JSON before preview reservation', async () => {
    const selectedIdentityRuntime = identityRuntime(
      vi.fn().mockResolvedValue(undefined),
      true,
    );
    const getDraft = vi.fn().mockRejectedValue(new Error('not used'));
    const acceptPreview = vi.fn().mockRejectedValue(new Error('not used'));
    applicationFixture.application = await createTestApiApplication(config, {
      ...dependencies(),
      identityRuntime: selectedIdentityRuntime,
      workflowRuntime: nodeTestingWorkflowRuntime(
        selectedIdentityRuntime.dependencies.authorization,
        { ...workflowAuthoringDatabase(), getDraft, acceptPreview },
      ),
    });
    const csrf = 'c'.repeat(32);
    const payload = `{"mode":"validate","expectedRevision":1,"sampleInput":${'['.repeat(10_000)}null${']'.repeat(10_000)}}`;
    const response = await applicationFixture.application.inject({
      method: 'POST',
      url: '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/workflows/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/draft/nodes/cccccccc-cccc-4ccc-8ccc-cccccccccccc/test',
      headers: {
        cookie: `pertexo_session=${'s'.repeat(43)}; pertexo_csrf=${csrf}`,
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'request.invalid' });
    expect(getDraft).not.toHaveBeenCalled();
    expect(acceptPreview).not.toHaveBeenCalled();
  });

  it('mounts Better Auth on the public web origin', async () => {
    const selected = betterAuthIdentityRuntime();
    applicationFixture.application = await createTestApiApplication(
      {
        ...config,
        identity: betterAuthIdentityConfig('https://app.example.test'),
      },
      { ...dependencies(), identityRuntime: selected.runtime },
    );
    await applicationFixture.application.init();

    const capabilities = await applicationFixture.application.inject({
      method: 'GET',
      url: '/v1/auth/capabilities',
    });
    expect(capabilities.json()).toEqual({
      password: {
        enabled: true,
        minimumLength: 12,
        verificationRequired: true,
      },
      socialProviders: ['google'],
    });
    const crossOrigin = await applicationFixture.application.inject({
      method: 'POST',
      url: '/v1/auth/sign-in/email',
      headers: { origin: 'https://api.example.test' },
      payload: {},
    });
    expect(crossOrigin.statusCode).toBe(403);
    const accepted = await applicationFixture.application.inject({
      method: 'POST',
      url: '/v1/auth/sign-in/email',
      headers: { origin: 'https://app.example.test' },
      payload: {},
    });
    expect(accepted.statusCode).toBe(200);
    expect(selected.requests).toEqual([
      'POST https://app.example.test/v1/auth/sign-in/email',
    ]);
  });

  it('closes an injected identity runtime when database readiness fails', async () => {
    const identityClose = vi.fn().mockResolvedValue(undefined);
    const workflowClose = vi.fn().mockResolvedValue(undefined);
    const selectedIdentityRuntime = identityRuntime(identityClose);
    const incompatibleDatabase: WorkspaceDatabase = {
      ...database,
      checkReadiness: vi
        .fn()
        .mockRejectedValue(new Error('migration mismatch')),
    };

    await expect(
      createTestApiApplication(config, {
        ...dependencies(incompatibleDatabase),
        identityRuntime: selectedIdentityRuntime,
        workflowRuntime: createStubApiWorkflowRuntime(
          selectedIdentityRuntime.dependencies.authorization,
          workflowClose,
        ),
      }),
    ).rejects.toThrow('migration mismatch');
    expect(identityClose).toHaveBeenCalledOnce();
    expect(workflowClose).toHaveBeenCalledOnce();
  });
}
