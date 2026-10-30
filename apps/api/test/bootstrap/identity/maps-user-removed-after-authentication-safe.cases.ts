import { expect, it, vi } from 'vitest';
import { createTestApiApplication } from '../../support/api-application.js';

import type { ApiWebhookRuntime } from '../../../src/platform/webhooks/runtime.module.js';
import type { WebhookManagementService } from '../../../src/webhooks/management/service.js';

import { EMPTY_WORKFLOW_GRAPH } from '@pertexo/workflow-model';
import {
  AuthoringValidationUnavailableError,
  EMPTY_DEFINITION_CATALOG,
  workflowCompatibilityReport,
} from '@pertexo/workflow-model/server';
import { createDraftRepresentationTag } from '../../../src/workflow-authoring/http/etag.js';
import { createStubApiWorkflowRuntime } from '../../support/api-platform.fixture.js';
import {
  config,
  dependencies,
  identityRuntime,
  applicationFixture,
} from '../fixture.js';

export function registerMapsUserRemovedAfterAuthenticationSafe(): void {
  it('maps a user removed after authentication to safe profile problem details', async () => {
    const selectedIdentityRuntime = identityRuntime(undefined, true);
    applicationFixture.application = await createTestApiApplication(config, {
      ...dependencies(),
      identityRuntime: {
        ...selectedIdentityRuntime,
        dependencies: {
          ...selectedIdentityRuntime.dependencies,
          persistence: {
            ...selectedIdentityRuntime.dependencies.persistence,
            findUserById: () => Promise.resolve(null),
          },
        },
      },
    });
    await applicationFixture.application.init();

    const response = await applicationFixture.application.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { cookie: `pertexo_session=${'s'.repeat(43)}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(response.json()).toMatchObject({ code: 'auth.unauthenticated' });
  });

  it('serves checked-snapshot ETag and admission 503 through real HTTP guards without bypassing session CSRF', async () => {
    const selectedIdentity = identityRuntime(
      vi.fn().mockResolvedValue(undefined),
      true,
    );
    const baseRuntime = createStubApiWorkflowRuntime(
      selectedIdentity.dependencies.authorization,
    );
    const graph = EMPTY_WORKFLOW_GRAPH;
    const compatibility = workflowCompatibilityReport(
      graph,
      EMPTY_DEFINITION_CATALOG,
    );
    const draft = {
      workflowId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      revision: 11,
      graphJson: graph,
      compatibility,
      updatedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      updatedAt: new Date(),
    };
    const validateDraft = vi.fn().mockResolvedValue({
      currentPublication: null,
      draft,
      validation: {
        ok: true,
        issues: [],
        expandedInvocations: 0,
        worstCaseLoopIterations: 0,
      },
    });
    applicationFixture.application = await createTestApiApplication(config, {
      ...dependencies(),
      identityRuntime: selectedIdentity,
      workflowRuntime: {
        ...baseRuntime,
        dependencies: {
          ...baseRuntime.dependencies,
          persistence: {
            ...baseRuntime.dependencies.persistence,
            validateDraft,
          },
        },
      },
    });
    const url = `/v1/workspaces/${draft.workspaceId}/workflows/${draft.workflowId}/validate`;
    const cookie = `pertexo_session=${'s'.repeat(43)}`;
    const denied = await applicationFixture.application.inject({
      method: 'POST',
      url,
      headers: { cookie },
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    expect(validateDraft).not.toHaveBeenCalled();
    const csrf = 'c'.repeat(32);
    const headers = {
      cookie: `${cookie}; pertexo_csrf=${csrf}`,
      'x-csrf-token': csrf,
    };
    const checked = await applicationFixture.application.inject({
      method: 'POST',
      url,
      headers,
      payload: {},
    });
    expect(checked.statusCode).toBe(200);
    expect(checked.headers.etag).toBe(
      createDraftRepresentationTag({
        workflowId: draft.workflowId,
        revision: draft.revision,
        graph,
        compatibilityFingerprint: compatibility.fingerprint,
      }),
    );
    expect(checked.json()).toMatchObject({
      valid: true,
      currentPublication: null,
      issues: [],
      compatibility,
    });
    validateDraft.mockRejectedValue(
      new AuthoringValidationUnavailableError('overloaded'),
    );
    const unavailable = await applicationFixture.application.inject({
      method: 'POST',
      url,
      headers,
      payload: {},
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.headers['retry-after']).toBe('1');
    expect(unavailable.json()).toMatchObject({
      code: 'workflow.validation_unavailable',
      status: 503,
    });
    expect(validateDraft).toHaveBeenCalledWith(
      draft.workspaceId,
      draft.workflowId,
      draft.updatedBy,
      expect.anything(),
    );
    expect(validateDraft.mock.calls[0]?.[3]).toHaveProperty(
      'signal',
      expect.any(AbortSignal),
    );
  });

  it('registers workflow routes and closes identity and workflow runtimes together', async () => {
    const identityClose = vi.fn().mockResolvedValue(undefined);
    const workflowClose = vi.fn().mockResolvedValue(undefined);
    const selectedIdentityRuntime = identityRuntime(identityClose);
    applicationFixture.application = await createTestApiApplication(config, {
      ...dependencies(),
      identityRuntime: selectedIdentityRuntime,
      workflowRuntime: createStubApiWorkflowRuntime(
        selectedIdentityRuntime.dependencies.authorization,
        workflowClose,
      ),
    });
    await applicationFixture.application.init();

    const response = await applicationFixture.application.inject({
      method: 'GET',
      url: '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/workflows',
    });
    expect(response.statusCode).toBe(401);

    const runResponse = await applicationFixture.application.inject({
      method: 'GET',
      url: '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/runs/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    expect(runResponse.statusCode).toBe(401);

    await applicationFixture.application.close();
    applicationFixture.application = undefined;
    expect(identityClose).toHaveBeenCalledOnce();
    expect(workflowClose).toHaveBeenCalledOnce();
  });

  it('registers the encapsulated webhook route and closes its runtime', async () => {
    const selectedIdentityRuntime = identityRuntime();
    const webhookClose = vi.fn().mockResolvedValue(undefined);
    const webhookRuntime = {
      service: {} as WebhookManagementService,
      ingress: {
        database: {
          resolveVerification: vi.fn().mockResolvedValue(null),
        },
        encryption: {},
        checkpointFactory: () => ({ checkpoint: {} }),
      },
      close: webhookClose,
    } as unknown as ApiWebhookRuntime;
    applicationFixture.application = await createTestApiApplication(config, {
      ...dependencies(),
      identityRuntime: selectedIdentityRuntime,
      webhookRuntime,
    });

    const response = await applicationFixture.application.inject({
      method: 'POST',
      url: `/hooks/${'a'.repeat(43)}`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ code: string }>().code).toBe(
      'webhook.authentication_failed',
    );

    const management = await applicationFixture.application.inject({
      method: 'GET',
      url: '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/workflows/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/triggers',
    });
    expect(management.statusCode).toBe(401);

    await applicationFixture.application.close();
    applicationFixture.application = undefined;
    expect(webhookClose).toHaveBeenCalledOnce();
  });
}
