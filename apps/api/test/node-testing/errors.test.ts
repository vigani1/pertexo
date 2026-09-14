import type { ArgumentsHost } from '@nestjs/common';
import { apiProblemSchema } from '@pertexo/contracts/errors';
import {
  PriorPreviewInputUnavailableError,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '@pertexo/database/testing';
import {
  InvalidWorkflowGraphError,
  WorkflowGraphContractError,
} from '@pertexo/workflow-model/graph';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { APPLICATION_ERROR_MAPPERS } from '../../src/application-error-mappers.js';
import { InvalidAuthenticatedWorkspaceContextError } from '../../src/identity-workspace/authenticated-command-context-error.js';
import {
  mapNodeTestingError,
  NodeTestInvalidError,
  NodeTestRequestError,
} from '../../src/node-testing/errors.js';
import {
  applicationError,
  InvalidIdempotencyKeyError,
  ProblemDetailsFilter,
  RequestContextStore,
} from '../../src/platform/http/index.js';
import { AuthorizationError } from '../../src/workspaces/index.js';

describe('node testing error mapping', () => {
  it.each([
    [
      'missing idempotency',
      new NodeTestRequestError('idempotency_required'),
      'request.precondition_required',
      'Idempotency-Key is required for test_execute.',
    ],
    [
      'changed idempotent request',
      new NodeTestRequestError('idempotency_conflict'),
      'request.idempotency_conflict',
      'The idempotency key was already used for another request.',
    ],
    [
      'invalid idempotency syntax',
      new InvalidIdempotencyKeyError(),
      'request.invalid',
      'Idempotency-Key must contain exactly one valid value',
    ],
    [
      'invalid authenticated context',
      new InvalidAuthenticatedWorkspaceContextError('invalid actor'),
      'request.invalid',
      'invalid actor',
    ],
    [
      'authorization denial',
      new AuthorizationError('resource.not_found', 'hidden'),
      'resource.not_found',
      'hidden',
    ],
    [
      'missing workflow or preview',
      new WorkflowNotFoundError(),
      'resource.not_found',
      undefined,
    ],
    [
      'unavailable prior preview input',
      new PriorPreviewInputUnavailableError(),
      'workflow.invalid',
      'The selected prior preview output is unavailable.',
    ],
    [
      'graph contract failure',
      new WorkflowGraphContractError(
        'graph_limit',
        '$.nodes',
        'too many nodes',
      ),
      'request.invalid',
      'The workflow graph is invalid.',
    ],
    [
      'request schema failure',
      new z.ZodError([]),
      'request.invalid',
      'The workflow graph is invalid.',
    ],
  ] as const)(
    'maps %s to its exact bounded public problem',
    (name, failure, code, safeDetail) => {
      void name;
      expect(mapNodeTestingError(failure)).toEqual({
        code,
        ...(safeDetail === undefined ? {} : { safeDetail }),
      });
    },
  );

  it('preserves exact revision metadata', () => {
    expect(
      mapNodeTestingError(new WorkflowRevisionConflictError(7, 'etag')),
    ).toEqual({
      code: 'workflow.revision_conflict',
      safeDetail: 'The workflow draft has changed; reload it before retrying.',
      details: { currentRevision: 7, currentEtag: 'etag' },
    });
  });

  it('preserves bounded selected-node issues without unrelated material', () => {
    const failure = new NodeTestInvalidError([
      {
        code: 'node.config_version_incompatible',
        path: '$.configVersion',
        message: 'Selected node configuration version is incompatible',
      },
    ]);
    const mapped = mapNodeTestingError(failure);

    expect(mapped).toEqual({
      code: 'workflow.invalid',
      safeDetail: 'The selected node is not valid for preview.',
      details: { issues: failure.issues },
    });
    expect(JSON.stringify(mapped)).not.toContain('credential-secret');
  });

  it('serializes bounded selected-node issues without private fields at the global filter seam', () => {
    const response = {
      body: undefined as unknown,
      status: vi.fn(),
      header: vi.fn(),
      send: vi.fn(),
    };
    response.status.mockReturnValue(response);
    response.send.mockImplementation((body: unknown) => {
      response.body = body;
    });
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({
          url: '/v1/workspaces/workspace-a/workflows/workflow-a/draft/nodes/http/test',
        }),
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;
    const issue = Object.assign(
      {
        code: 'node.config_version_incompatible',
        path: '$.configVersion',
        message: 'Selected node configuration version is incompatible',
      },
      { privateCredential: 'credential-secret' },
    );
    const contexts = new RequestContextStore();

    contexts.run('request-node-validation', () => {
      new ProblemDetailsFilter(
        contexts,
        undefined,
        APPLICATION_ERROR_MAPPERS,
      ).catch(new NodeTestInvalidError([issue]), host);
    });

    expect(response.status).toHaveBeenCalledWith(422);
    expect(response.body).toEqual({
      type: 'urn:pertexo:problem:workflow.invalid',
      title: 'Invalid workflow',
      status: 422,
      detail: 'The selected node is not valid for preview.',
      instance:
        '/v1/workspaces/workspace-a/workflows/workflow-a/draft/nodes/http/test',
      code: 'workflow.invalid',
      requestId: 'request-node-validation',
      errors: [
        {
          code: 'node.config_version_incompatible',
          path: '$.configVersion',
          message: 'Selected node configuration version is incompatible',
        },
      ],
    });
    expect(apiProblemSchema.safeParse(response.body).success).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain('credential-secret');
  });

  it('preserves semantic graph issues at the workflow-invalid seam', () => {
    const failure = new InvalidWorkflowGraphError([
      {
        path: '$.nodes[0]',
        code: 'unknown_definition',
        message: 'definition is missing',
      },
    ]);
    expect(mapNodeTestingError(failure)).toEqual({
      code: 'workflow.invalid',
      safeDetail: 'The workflow cannot be tested in its current form.',
      details: { issues: failure.issues },
    });
  });

  it('returns an existing application error by identity', () => {
    const failure = applicationError('provider.unavailable', {
      safeDetail: 'Provider is unavailable.',
    });
    expect(mapNodeTestingError(failure)).toBe(failure);
  });

  it('retains an unknown secret-bearing cause only on the internal error', () => {
    const failure = new Error('credential-secret');
    const mapped = mapNodeTestingError(failure);

    expect(mapped).toMatchObject({
      code: 'internal.unexpected',
      cause: failure,
    });
    expect(JSON.stringify(mapped)).not.toContain('credential-secret');
  });
});
