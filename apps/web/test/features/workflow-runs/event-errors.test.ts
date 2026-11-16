import { expect, it } from 'vitest';
import { classifyStreamFailure } from '@/lib/api/stream-reconnect';
import {
  decodeRunEvent,
  classifyRunEvent,
} from '@/features/workflow-runs/model/timeline/run-events';
import { RunEventError } from '@/features/workflow-runs/model/timeline/run-events.errors';
import { event } from './events/fixture';

it.each([
  [
    'invalid-json',
    () => decodeRunEvent({ id: '1', event: 'node.progress', data: '{' }),
  ],
  [
    'metadata-mismatch',
    () =>
      decodeRunEvent({
        id: '2',
        event: 'node.progress',
        data: JSON.stringify(event(1)),
      }),
  ],
  ['sequence-gap', () => classifyRunEvent(1, event(3))],
] as const)(
  'keeps %s failures unreadable rather than reconnecting',
  (kind, read) => {
    let failure: unknown;
    try {
      read();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RunEventError);
    expect(failure).toMatchObject({ kind });
    expect(classifyStreamFailure(failure, 1)).toEqual({
      kind: 'stop',
      reason: 'unreadable',
    });
  },
);
