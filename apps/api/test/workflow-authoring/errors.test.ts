import { WorkflowEngineError } from '@pertexo/workflow-engine';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  WorkflowLifecycleRevisionConflictError,
  WorkflowNameRevisionConflictError,
  WorkflowPauseRevisionConflictError,
  WorkflowAutoPauseSettingsRevisionConflictError,
  WorkspaceAutoPauseSettingsRevisionConflictError,
  WorkflowTemplateOriginUnavailableError,
} from '@pertexo/database/authoring';
import { IdempotencyConflictError } from '@pertexo/database/platform';
import {
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
import { WorkflowHeaderError } from '../../src/workflow-authoring/http/preconditions.js';
import { AuthorizationError } from '../../src/authorization/index.js';

const tag = '"draft-v1.abcdefghijklmnopqrstuvwxyz0123456789_-abcde"';

describe('workflow authoring error mapping', () => {
  it('maps unsupported historical origin readers to a dedicated sanitized unavailable problem', () => {
    expect(
      mapWorkflowAuthoringError(new WorkflowTemplateOriginUnavailableError()),
    ).toEqual({
      code: 'workflow.template_origin_unavailable',
      safeDetail: 'Historical template origin is temporarily unavailable.',
    });
  });
  it('projects operational conflicts without losing bigint revision precision', () => {
    expect(
      mapWorkflowAuthoringError(
        new WorkflowPauseRevisionConflictError('9007199254740993'),
      ),
    ).toMatchObject({
      code: 'workflow.pause_conflict',
      details: { currentPauseRevision: '9007199254740993' },
    });
    expect(
      mapWorkflowAuthoringError(
        new WorkflowAutoPauseSettingsRevisionConflictError(2),
      ),
    ).toMatchObject({
      code: 'workflow.auto_pause_settings_conflict',
      details: { currentSettingsRevision: 2 },
    });
    expect(
      mapWorkflowAuthoringError(
        new WorkspaceAutoPauseSettingsRevisionConflictError(3),
      ),
    ).toMatchObject({
      code: 'workspace.auto_pause_settings_conflict',
      details: { currentRevision: 3 },
    });
  });
  it.each([
    [
      'missing If-Match',
      new WorkflowHeaderError('precondition_required'),
      {
        code: 'request.precondition_required',
        safeDetail: 'If-Match is required for this operation.',
      },
    ],
    [
      'malformed If-Match',
      new WorkflowHeaderError('invalid'),
      {
        code: 'request.invalid',
        safeDetail: 'If-Match must contain exactly one valid value',
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
      new IdempotencyConflictError(),
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
      'executable compile failure',
      new WorkflowEngineError(
        'executable_invalid',
        'workflow edge source port is not configured',
      ),
      {
        code: 'workflow.invalid',
        safeDetail:
          'A step’s setup is incomplete, so the workflow can’t be published yet.',
        details: {
          issues: [
            {
              path: '$.nodes',
              code: 'executable_invalid',
              message:
                'A Switch or Parallel step has a connection from a branch it doesn’t define. Add that branch in its setup, or remove the connection.',
            },
          ],
        },
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
      mapWorkflowAuthoringError(new WorkflowNameRevisionConflictError(5)),
    ).toEqual({
      code: 'workflow.name_conflict',
      safeDetail:
        'The workflow was renamed meanwhile; reload it before retrying.',
      details: { currentNameRevision: 5 },
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
