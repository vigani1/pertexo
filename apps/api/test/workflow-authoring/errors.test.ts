import { describe, expect, it } from 'vitest';
import {
  WorkflowCreateIdempotencyConflictError,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '@pertexo/database';

import {
  mapWorkflowAuthoringError,
  WorkflowVersionListingUnavailableError,
} from '../../src/workflow-authoring/errors.js';

describe('workflow authoring error mapping', () => {
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

  it('maps idempotency conflicts and reports the versions persistence seam gap', () => {
    expect(
      mapWorkflowAuthoringError(new WorkflowCreateIdempotencyConflictError()),
    ).toMatchObject({ code: 'request.idempotency_conflict' });
    expect(
      mapWorkflowAuthoringError(new WorkflowVersionListingUnavailableError()),
    ).toMatchObject({ code: 'internal.unexpected' });
  });
});
