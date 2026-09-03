import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '@pertexo/database/testing';
import { describe, expect, it } from 'vitest';

import {
  mapNodeTestingError,
  NodeTestInvalidError,
  NodeTestRequestError,
} from '../../src/node-testing/errors.js';

describe('node testing error mapping', () => {
  it('owns preview precondition and validation errors', () => {
    expect(
      mapNodeTestingError(new NodeTestRequestError('idempotency_required')),
    ).toMatchObject({ code: 'request.precondition_required' });
    expect(
      mapNodeTestingError(new NodeTestRequestError('idempotency_conflict')),
    ).toMatchObject({ code: 'request.idempotency_conflict' });
    expect(
      mapNodeTestingError(
        new NodeTestInvalidError([
          { code: 'node_missing', path: '$.nodes', message: 'missing' },
        ]),
      ),
    ).toMatchObject({ code: 'workflow.invalid' });
  });

  it('preserves shared persistence visibility and revision semantics', () => {
    expect(mapNodeTestingError(new WorkflowNotFoundError())).toMatchObject({
      code: 'resource.not_found',
    });
    expect(
      mapNodeTestingError(new WorkflowRevisionConflictError(7, 'etag')),
    ).toMatchObject({
      code: 'workflow.revision_conflict',
      details: { currentRevision: 7, currentEtag: 'etag' },
    });
  });
});
