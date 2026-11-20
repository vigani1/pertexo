import { expect, it } from 'vitest';
import { isWorkflowTriggerKey } from '../../src/graph/triggers.js';
import {
  httpPollConfigSchema,
  HTTP_POLL_TRIGGER,
} from '../../src/triggers/polling.schemas.js';

const config = {
  url: 'https://example.test/feed',
  intervalMinutes: 1,
  itemsPath: '$',
  itemKeyPath: '$.id',
};

it('accepts the schedule interval bounds and a root array path', () => {
  expect(httpPollConfigSchema.parse(config)).toEqual(config);
  expect(
    httpPollConfigSchema.safeParse({ ...config, intervalMinutes: 43_200 })
      .success,
  ).toBe(true);
});

it.each([
  { intervalMinutes: 0 },
  { intervalMinutes: 1.5 },
  { intervalMinutes: 43_201 },
  { itemKeyPath: '$..id' },
  { url: 'file:///local.json' },
])('rejects invalid polling configuration %j', (invalid) => {
  expect(
    httpPollConfigSchema.safeParse({ ...config, ...invalid }).success,
  ).toBe(false);
});

it('keeps polling out of the authorable trigger definitions in slice 1', () => {
  expect(isWorkflowTriggerKey(HTTP_POLL_TRIGGER.key)).toBe(false);
});
