// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { audienceSentence } from '@/features/pending-tasks/model/task-presentation';

describe('who a request went to', () => {
  it('names the roles and members an approval went to', () => {
    expect(
      audienceSentence({
        kind: 'approval',
        audience: { roles: ['owner', 'admin'], memberIds: ['a', 'b'] },
      }),
    ).toBe(
      'It went to owners and admins and 2 named members. The first decision counts.',
    );
  });

  it('lets the starter answer an input request', () => {
    expect(
      audienceSentence({
        kind: 'input_request',
        audience: { roles: [], memberIds: ['a'] },
      }),
    ).toBe(
      'It went to 1 named member. The first response counts, including from the person who started the run.',
    );
  });
});
