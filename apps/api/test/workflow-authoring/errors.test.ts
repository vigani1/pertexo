import { describe, expect, it } from 'vitest';
import { WorkflowLifecycleRevisionConflictError } from '@pertexo/database/api';
import {
  WorkflowIdempotencyConflictError,
  WorkflowDefinitionPlacementError,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '@pertexo/database/testing';

import { mapWorkflowAuthoringError } from '../../src/workflow-authoring/errors.js';
import { InvalidWorkflowCursorError } from '../../src/workflow-authoring/use-cases.js';

describe('workflow authoring error mapping', () => {
  it('keeps lifecycle concurrency distinct from draft ETags', () => {
    const problem = mapWorkflowAuthoringError(
      new WorkflowLifecycleRevisionConflictError(4),
    );
    expect(problem).toMatchObject({
      code: 'workflow.lifecycle_conflict',
      details: { currentLifecycleRevision: 4 },
    });
    expect(problem.details).not.toHaveProperty('currentEtag');
  });

  it('uses shared RFC problem codes and preserves safe revision details', () => {
    expect(
      mapWorkflowAuthoringError(new WorkflowNotFoundError()),
    ).toMatchObject({
      code: 'resource.not_found',
    });
    expect(
      mapWorkflowAuthoringError(
        new WorkflowRevisionConflictError(
          3,
          '"draft-v1.abcdefghijklmnopqrstuvwxyz0123456789_-abcde"',
        ),
      ),
    ).toMatchObject({
      code: 'workflow.revision_conflict',
      details: {
        currentRevision: 3,
        currentEtag: '"draft-v1.abcdefghijklmnopqrstuvwxyz0123456789_-abcde"',
      },
    });
  });

  it('maps idempotency conflicts and invalid cursors', () => {
    expect(
      mapWorkflowAuthoringError(new WorkflowIdempotencyConflictError()),
    ).toMatchObject({ code: 'request.idempotency_conflict' });
    expect(
      mapWorkflowAuthoringError(new InvalidWorkflowCursorError()),
    ).toMatchObject({ code: 'request.invalid' });
  });

  it('maps blocked definition placement to a bounded workflow problem', () => {
    expect(
      mapWorkflowAuthoringError(
        new WorkflowDefinitionPlacementError([
          {
            code: 'definition_not_placeable',
            path: '$.nodes.manual.definition',
            message:
              'Definition core.manual@1 cannot be newly placed in the current compatibility release.',
          },
        ]),
      ),
    ).toMatchObject({
      code: 'workflow.invalid',
      details: {
        issues: [
          {
            code: 'definition_not_placeable',
            path: '$.nodes.manual.definition',
          },
        ],
      },
    });
  });
});
