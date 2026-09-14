import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WorkflowLifecycleRevisionConflictError } from '@pertexo/database/api';
import {
  WorkflowIdempotencyConflictError,
  WorkflowDefinitionPlacementError,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '@pertexo/database/testing';

import {
  applicationError,
  type ApplicationError,
} from '../../src/platform/http/index.js';
import { InvalidWorkflowCursorError } from '../../src/workflow-authoring/cursor.js';
import { mapWorkflowAuthoringError } from '../../src/workflow-authoring/errors.js';
import {
  InvalidWorkflowGraphError,
  WorkflowGraphContractError,
} from '../../src/workflow-authoring/graph.js';
import { WorkflowHeaderError } from '../../src/workflow-authoring/preconditions.js';
import { AuthorizationError } from '../../src/workspaces/index.js';

const tag = '"draft-v1.abcdefghijklmnopqrstuvwxyz0123456789_-abcde"';

describe('workflow authoring error mapping', () => {
  it.each([
    [
      'missing If-Match',
      new WorkflowHeaderError('precondition_required', 'If-Match'),
      {
        code: 'request.precondition_required',
        safeDetail: 'If-Match is required for this operation.',
      },
    ],
    [
      'malformed idempotency key',
      new WorkflowHeaderError('invalid', 'Idempotency-Key'),
      {
        code: 'request.invalid',
        safeDetail: 'Idempotency-Key must contain exactly one valid value',
      },
    ],
    [
      'invalid cursor',
      new InvalidWorkflowCursorError(),
      {
        code: 'request.invalid',
        safeDetail: 'The workflow cursor is invalid.',
      },
    ],
    [
      'authorization denial',
      new AuthorizationError('resource.not_found', 'hidden workflow'),
      { code: 'resource.not_found', safeDetail: 'hidden workflow' },
    ],
    [
      'missing workflow',
      new WorkflowNotFoundError(),
      { code: 'resource.not_found' },
    ],
    [
      'idempotency conflict',
      new WorkflowIdempotencyConflictError(),
      {
        code: 'request.idempotency_conflict',
        safeDetail: 'The idempotency key was already used for another request.',
      },
    ],
    [
      'graph contract failure',
      new WorkflowGraphContractError(
        'graph_limit',
        '$.nodes',
        'too many nodes',
      ),
      {
        code: 'request.invalid',
        safeDetail: 'The workflow graph is invalid.',
      },
    ],
    [
      'request schema failure',
      new z.ZodError([]),
      {
        code: 'request.invalid',
        safeDetail: 'The workflow graph is invalid.',
      },
    ],
  ] as const)(
    'maps %s to its exact bounded application error',
    (_name, failure, expected) => {
      expect(mapWorkflowAuthoringError(failure)).toEqual(expected);
    },
  );

  it('keeps lifecycle concurrency distinct from draft validator concurrency', () => {
    expect(
      mapWorkflowAuthoringError(new WorkflowLifecycleRevisionConflictError(4)),
    ).toEqual({
      code: 'workflow.lifecycle_conflict',
      safeDetail:
        'The workflow lifecycle has changed; reload it before retrying.',
      details: { currentLifecycleRevision: 4 },
    });
    expect(
      mapWorkflowAuthoringError(new WorkflowRevisionConflictError(3, tag)),
    ).toEqual({
      code: 'workflow.revision_conflict',
      safeDetail: 'The workflow draft has changed; reload it before retrying.',
      details: { currentRevision: 3, currentEtag: tag },
    });
  });

  it('preserves exact bounded placement and semantic graph issues', () => {
    const placement = new WorkflowDefinitionPlacementError([
      {
        code: 'definition_not_placeable',
        path: '$.nodes.manual.definition',
        message:
          'Definition core.manual@1 cannot be newly placed in the current compatibility release.',
      },
    ]);
    expect(mapWorkflowAuthoringError(placement)).toEqual({
      code: 'workflow.invalid',
      safeDetail:
        'The workflow contains a definition that can no longer be added.',
      details: { issues: placement.issues },
    });

    const invalid = new InvalidWorkflowGraphError([
      {
        code: 'unknown_definition',
        path: '$.nodes[0].definition',
        message: 'definition is unavailable',
      },
    ]);
    expect(mapWorkflowAuthoringError(invalid)).toEqual({
      code: 'workflow.invalid',
      safeDetail: 'The workflow cannot be published in its current form.',
      details: { issues: invalid.issues },
    });
  });

  it('returns an existing application error by identity', () => {
    const failure = applicationError('provider.unavailable', {
      safeDetail: 'Provider is unavailable.',
    });
    expect(mapWorkflowAuthoringError(failure)).toBe(failure);
  });

  it('retains an unknown secret-bearing cause only on the internal error', () => {
    const failure = new Error('database-password');
    const mapped: ApplicationError = mapWorkflowAuthoringError(failure);

    expect(mapped).toMatchObject({
      code: 'internal.unexpected',
      cause: failure,
    });
    expect(JSON.stringify(mapped)).not.toContain('database-password');
  });
});
