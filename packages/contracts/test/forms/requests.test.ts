import { expect, it } from 'vitest';
import {
  formSchemaResponseSchema,
  formSubmissionResponseSchema,
  publicFormSubmissionResponseSchema,
} from '../../src/schemas/forms/requests.js';
import { formConfigSchema } from '@pertexo/workflow-model';
const versionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
it('requires the accepted version message in a receipt, without granting public run history', () => {
  const receipt = {
    accepted: true,
    replayed: false,
    thankYouMessage: 'Received.',
  };
  expect(formSubmissionResponseSchema.parse(receipt)).toEqual(receipt);
  expect(
    formSubmissionResponseSchema.safeParse({ accepted: true, replayed: false })
      .success,
  ).toBe(false);
  expect(
    publicFormSubmissionResponseSchema.safeParse({
      ...receipt,
      runId: versionId,
    }).success,
  ).toBe(false);
});
it('publishes the fields separately from the post-acceptance message', () => {
  const form = formConfigSchema.parse({});
  expect(formSchemaResponseSchema.parse({ versionId, form }).form).toEqual(
    form,
  );
  expect(
    formSchemaResponseSchema.safeParse({
      versionId,
      form: { ...form, thankYouMessage: 'Only after acceptance.' },
    }).success,
  ).toBe(false);
});

it('keeps busy receipts separate from accepted responses and public run history', () => {
  const busy = {
    accepted: false,
    skipped: true,
    reason: 'concurrency_limit',
    replayed: false,
  };
  expect(formSubmissionResponseSchema.parse(busy)).toEqual(busy);
  expect(publicFormSubmissionResponseSchema.parse(busy)).toEqual(busy);
  for (const extra of [
    { runId: versionId },
    { thankYouMessage: 'Accepted' },
    { redirectUrl: 'https://example.test/' },
  ])
    expect(
      publicFormSubmissionResponseSchema.safeParse({ ...busy, ...extra })
        .success,
    ).toBe(false);
});
