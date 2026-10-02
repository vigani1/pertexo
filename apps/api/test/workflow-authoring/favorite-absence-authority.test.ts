import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createWorkflowFavoriteAbsenceAuthority,
  workflowFavoriteAbsenceAuthority,
} from '../../src/workflow-authoring/favorite-absence-authority.js';
import { InvalidWorkflowFavoriteAbsenceTokenError } from '../../src/workflow-authoring/favorite-absence-token.js';

const scope = {
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  workflowId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const generation = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const snapshot = { generation, issuedAtSeconds: 100 };
describe('application favorite absence authority', () => {
  it('uses the actual codec and rejects a token against a different membership generation', () => {
    const authority = createWorkflowFavoriteAbsenceAuthority(randomBytes(32));
    const token = authority.issue(scope, snapshot);
    expect(authority.verify(token, scope, generation)).toEqual({
      ...snapshot,
      expiresAtSeconds: 86500,
    });
    expect(authority.verify(token, scope, scope.workflowId)).toBeNull();
    expect(authority.verify('absent', scope, generation)).toBeNull();
  });

  it('maps only the known invalid-token failure, preserving unexpected operational errors', () => {
    const verify = vi.fn();
    const authority = workflowFavoriteAbsenceAuthority({
      issue: vi.fn(),
      verify,
    });
    verify.mockImplementationOnce(() => {
      throw new InvalidWorkflowFavoriteAbsenceTokenError();
    });
    expect(authority.verify('invalid', scope, generation)).toBeNull();
    const failure = new TypeError('unexpected operational failure');
    verify.mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => authority.verify('invalid', scope, generation)).toThrow(
      failure,
    );
  });
});
