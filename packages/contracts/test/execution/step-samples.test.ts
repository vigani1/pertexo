import { describe, expect, it } from 'vitest';
import {
  stepSampleWriteRequestSchema,
  stepSampleDeleteRequestSchema,
  stepSampleResponseSchema,
  stepSampleListResponseSchema,
} from '../../src/schemas/workflows/step-samples.js';
const id = '11111111-1111-4111-8111-111111111111';
const intent = {
  expectedDraftRevision: 1,
  expectedSampleId: null,
  source: { kind: 'json', value: { amount: 42 } },
};
describe('pinned sample boundary contracts', () => {
  it('requires explicit saved-draft and sample preconditions and refuses unsupported fields', () => {
    expect(stepSampleWriteRequestSchema.parse(intent)).toEqual(intent);
    expect(
      stepSampleWriteRequestSchema.safeParse({
        ...intent,
        expectedSampleId: undefined,
      }).success,
    ).toBe(false);
    expect(
      stepSampleWriteRequestSchema.safeParse({
        ...intent,
        expectedDraftRevision: 0,
      }).success,
    ).toBe(false);
    expect(
      stepSampleWriteRequestSchema.safeParse({
        ...intent,
        binding: 'client-forged',
      }).success,
    ).toBe(false);
    expect(
      stepSampleDeleteRequestSchema.safeParse({
        expectedDraftRevision: 1,
        expectedSampleId: null,
      }).success,
    ).toBe(false);
  });
  it('identifies the exact retained run step or preview instead of accepting a caller-supplied output', () => {
    for (const source of [
      { kind: 'run', runId: id, nodeRunId: id },
      { kind: 'preview', previewRunId: id },
      { kind: 'confirm' },
    ])
      expect(
        stepSampleWriteRequestSchema.safeParse({ ...intent, source }).success,
      ).toBe(true);
    expect(
      stepSampleWriteRequestSchema.safeParse({
        ...intent,
        source: { kind: 'run', runId: id },
      }).success,
    ).toBe(false);
    expect(
      stepSampleWriteRequestSchema.safeParse({
        ...intent,
        source: { kind: 'preview', previewRunId: id, value: 'forged' },
      }).success,
    ).toBe(false);
  });
  it('keeps metadata lists separate from selected payload reads, including valid JSON null', () => {
    const limits = { inlineBytes: 262144, depth: 64, members: 10000 };
    expect(
      stepSampleResponseSchema.parse({
        sample: null,
        output: null,
        draftRevision: 1,
        limits,
      }).output,
    ).toBeNull();
    expect(
      stepSampleListResponseSchema.safeParse({
        items: [],
        output: 'should-not-be-listed',
        draftRevision: 1,
        limits,
      }).success,
    ).toBe(false);
  });
});
