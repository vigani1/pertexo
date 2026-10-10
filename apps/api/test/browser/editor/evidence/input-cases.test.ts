import { describe, expect, it } from 'vitest';
import { workflowInputCasesEvidenceSchema } from './input-cases.js';

describe('workflow input case browser evidence envelope', () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ids = {
    workspaceId: id,
    workflowId: id,
    caseId: id,
    replacementCaseId: id,
    runId: id,
    workflowVersionId: id,
    nodeId: id,
    originalWorkflowVersionId: id,
    currentPublishedVersionId: id,
  };
  it('accepts bounded identities only; persisted facts are checked separately', () => {
    expect(workflowInputCasesEvidenceSchema.parse(ids)).toEqual(ids);
  });
  it('rejects missing source/final version identity and payload/name/key/session material', () => {
    const { originalWorkflowVersionId: _original, ...missingOriginal } = ids;
    const { currentPublishedVersionId: _current, ...missingCurrent } = ids;
    expect(
      workflowInputCasesEvidenceSchema.safeParse(missingOriginal).success,
    ).toBe(false);
    expect(
      workflowInputCasesEvidenceSchema.safeParse(missingCurrent).success,
    ).toBe(false);
    for (const field of [
      'input',
      'name',
      'key',
      'session',
      'expectedVersion',
      'outcome',
    ])
      expect(
        workflowInputCasesEvidenceSchema.safeParse({
          ...ids,
          [field]: 'not-evidence',
        }).success,
      ).toBe(false);
  });
});
