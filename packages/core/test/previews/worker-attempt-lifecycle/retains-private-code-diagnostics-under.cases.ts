import { withWorkspaceTransaction } from '@pertexo/database/primitives';
import { readPreviewRun } from '../../../src/previews/runs/records.queries.js';

import { expect, it } from 'vitest';
import { completePreviewAttempt } from '../../../src/previews/attempts/completion.repository.js';
import { PreviewAttemptStateError } from '../../../src/previews/errors.js';
import {
  acceptFixture,
  actorUserId,
  apiPool,
  claimFixture,
  previewTerminalFacts,
  workerPool,
  workspaceId,
} from '../worker.fixture.js';

export function registerRetainsPrivateCodeDiagnosticsUnder(): void {
  it('retains private Code diagnostics under the same completion fence and preview expiry', async () => {
    const claimed = await claimFixture(
      await acceptFixture(),
      'worker-code-preview',
    );
    const codeDiagnostics = {
      logs: [{ level: 'warn' as const, message: 'private preview log' }],
      truncated: false,
      error: { message: 'user-only diagnostic', line: 1 },
    };
    const input = {
      delivery: claimed.fixture.delivery,
      lease: claimed.lease,
      outcome: {
        status: 'failed' as const,
        safeErrorCode: 'code.runtime_error',
      },
      codeDiagnostics,
      workerId: claimed.workerId,
    };
    expect((await completePreviewAttempt(workerPool, input)).kind).toBe(
      'committed',
    );
    expect((await completePreviewAttempt(workerPool, input)).kind).toBe(
      'duplicate',
    );
    await expect(
      completePreviewAttempt(workerPool, {
        ...input,
        codeDiagnostics: { ...codeDiagnostics, logs: [] },
      }),
    ).rejects.toBeInstanceOf(PreviewAttemptStateError);
    const preview = await withWorkspaceTransaction(
      apiPool,
      workspaceId,
      (transaction) =>
        readPreviewRun(transaction, {
          actorUserId,
          previewRunId: claimed.fixture.previewRunId,
        }),
    );
    expect(preview?.codeDiagnostics).toEqual(codeDiagnostics);
    const facts = await previewTerminalFacts(claimed.fixture.previewRunId);
    expect(JSON.stringify(facts)).not.toContain('private preview log');
    expect(JSON.stringify(facts)).not.toContain('user-only diagnostic');
    const expired = await withWorkspaceTransaction(
      apiPool,
      workspaceId,
      (transaction) =>
        readPreviewRun(
          transaction,
          { actorUserId, previewRunId: claimed.fixture.previewRunId },
          new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
        ),
    );
    expect(expired).toBeNull();
  });

  it("keeps a step's own refusal reason with its failed preview", async () => {
    const claimed = await claimFixture(
      await acceptFixture(),
      'worker-refusal-preview',
    );
    const input = {
      delivery: claimed.fixture.delivery,
      lease: claimed.lease,
      outcome: {
        status: 'failed' as const,
        safeErrorCode: 'preview.input_invalid',
        errorSummary: 'Use a date like 2026-10-19.',
      },
      workerId: claimed.workerId,
    };
    expect((await completePreviewAttempt(workerPool, input)).kind).toBe(
      'committed',
    );
    expect((await completePreviewAttempt(workerPool, input)).kind).toBe(
      'duplicate',
    );
    await expect(
      completePreviewAttempt(workerPool, {
        ...input,
        outcome: { ...input.outcome, errorSummary: 'Another reason.' },
      }),
    ).rejects.toBeInstanceOf(PreviewAttemptStateError);
    const preview = await withWorkspaceTransaction(
      apiPool,
      workspaceId,
      (transaction) =>
        readPreviewRun(transaction, {
          actorUserId,
          previewRunId: claimed.fixture.previewRunId,
        }),
    );
    expect(preview).toMatchObject({
      status: 'failed',
      safeErrorCode: 'preview.input_invalid',
      errorSummary: 'Use a date like 2026-10-19.',
    });
  });
}
