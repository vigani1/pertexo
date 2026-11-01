import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  auditFor,
  base,
  schedule,
  sourceRunId,
  storedCommand,
  versionId,
} from './commands.support.js';

describe('oversized operator input', () => {
  it('rejects a replay input over 64 KiB as a promise and records nothing', async () => {
    const input = base();
    // A JSON string adds its two quotes.
    const refused = schedule.operator.replayRun({
      ...input,
      dryRun: true,
      runInput: 'a'.repeat(65_535),
      sourceRunId,
      workflowVersionId: versionId,
    });
    expect(refused).toBeInstanceOf(Promise);
    await expect(refused).rejects.toThrow(
      'Operator replay input must not exceed 65536 UTF-8 bytes',
    );
    expect(await storedCommand(input.commandId)).toBeUndefined();
    expect(await auditFor(input.commandId)).toEqual([]);
  });

  it('takes a replay input of exactly 64 KiB', async () => {
    await expect(
      schedule.operator.replayRun({
        ...base(),
        dryRun: true,
        runInput: 'a'.repeat(65_534),
        sourceRunId,
        workflowVersionId: versionId,
      }),
    ).resolves.toMatchObject({ outcome: 'would_request' });
  });

  it('rejects evidence over 4 KiB as a promise and records nothing', async () => {
    const input = base();
    const refused = schedule.operator.recordUnknownOutcomeEvidence({
      ...input,
      attemptId: randomUUID(),
      evidenceKind: 'provider.receipt',
      evidenceRef: { value: 'a'.repeat(4085) },
    });
    expect(refused).toBeInstanceOf(Promise);
    await expect(refused).rejects.toThrow(
      'Unknown outcome evidence must not exceed 4096 UTF-8 bytes',
    );
    expect(await storedCommand(input.commandId)).toBeUndefined();
    expect(await auditFor(input.commandId)).toEqual([]);
  });
});
