import { expect, it } from 'vitest';
import { hasNoPublishedTriggers } from '@/features/workflow-settings/model/triggers/published';

const none = {
  editable: true,
  webhookCount: 0,
  scheduleCount: 0,
  form: false,
  onFailure: false,
};

it('asks for a first trigger only when an editor knows the published version starts nothing', () => {
  expect(hasNoPublishedTriggers(none)).toBe(true);
  expect(hasNoPublishedTriggers({ ...none, editable: false })).toBe(false);
  expect(hasNoPublishedTriggers({ ...none, webhookCount: 1 })).toBe(false);
  expect(hasNoPublishedTriggers({ ...none, scheduleCount: 2 })).toBe(false);
  expect(hasNoPublishedTriggers({ ...none, form: true })).toBe(false);
  expect(hasNoPublishedTriggers({ ...none, onFailure: true })).toBe(false);
});

it('does not claim there are no triggers while a count is still unknown', () => {
  expect(hasNoPublishedTriggers({ ...none, webhookCount: undefined })).toBe(
    false,
  );
  expect(hasNoPublishedTriggers({ ...none, scheduleCount: undefined })).toBe(
    false,
  );
});
