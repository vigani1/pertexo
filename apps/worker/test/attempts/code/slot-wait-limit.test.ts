import { CODE_LIMITS, CODE_SETTING_BOUNDS } from '@pertexo/node-sdk';
import { QUEUE_CLASS_DEFAULTS, QUEUE_NAME } from '@pertexo/queue/server';
import { expect, it } from 'vitest';

// The slot wait lives with the Code limits (node-sdk) and the attempt's time
// limit with the queue's job defaults; neither package may import the other.
it("a Code step that waits out a busy runner and then runs the longest task ends inside its attempt's time limit", () => {
  const attemptSeconds =
    QUEUE_CLASS_DEFAULTS[QUEUE_NAME.nodeAttempts].timeoutMs / 1_000;
  expect(
    CODE_LIMITS.slotWaitSeconds + CODE_SETTING_BOUNDS.maximumSeconds,
  ).toBeLessThan(attemptSeconds);
});
