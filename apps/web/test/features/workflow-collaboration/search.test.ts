import { workflowCommentListQuerySchema } from '@pertexo/contracts';
import { describe, expect, it } from 'vitest';
import { parseCollaborationSearch } from '@/features/workflow-collaboration/model/search';

const threadId = '11111111-1111-4111-8111-111111111111';
const commentId = '22222222-2222-4222-8222-222222222222';

// A step deep link is a step ID the discussion list accepts: 1 to 128
// characters of storable text.
const steps = [
  { step: 'check', kept: true },
  { step: 'a'.repeat(128), kept: true },
  { step: 'a'.repeat(129), kept: false },
  { step: '', kept: false },
  { step: 'check\0', kept: false },
  { step: 'check\uD800', kept: false },
  { step: 42, kept: false },
];

describe('discussion deep links', () => {
  it.each(steps)(
    'keeps step $step only when it is a step ID',
    ({ step, kept }) => {
      expect(parseCollaborationSearch({ step })).toEqual(kept ? { step } : {});
    },
  );

  it.each(steps.filter(({ step }) => typeof step === 'string'))(
    'agrees with the discussion list on step $step',
    ({ step, kept }) => {
      expect(
        workflowCommentListQuerySchema.safeParse({
          scope: 'step',
          stepId: step,
        }).success,
      ).toBe(kept);
    },
  );

  it('keeps a comment only inside a valid thread', () => {
    expect(
      parseCollaborationSearch({ thread: threadId, comment: commentId }),
    ).toEqual({ thread: threadId, comment: commentId });
    expect(
      parseCollaborationSearch({ thread: 'not-a-thread', comment: commentId }),
    ).toEqual({});
    expect(
      parseCollaborationSearch({ thread: threadId, comment: 'nope' }),
    ).toEqual({ thread: threadId });
  });
});
