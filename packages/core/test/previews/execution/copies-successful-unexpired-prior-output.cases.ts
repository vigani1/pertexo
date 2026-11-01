import { eq } from 'drizzle-orm';

import { expect, it } from 'vitest';

import { PriorPreviewInputUnavailableError } from '../../../src/previews/errors.js';
import { previewAttempts, previewRuns } from '@pertexo/database/schema';

import {
  workspaceA,
  workspaceB,
  workflowB,
  workflowC,
  apiDatabase,
  digest,
  input,
  ownerWorkspaceQuery,
  hasPostgresCode,
  apiPreviews,
} from './fixture.js';

export function registerCopiesSuccessfulUnexpiredPriorOutput(): void {
  it('copies only a successful unexpired prior output in the same workflow', async () => {
    const first = await apiPreviews.acceptPreview({
      workspaceId: workspaceA,
      ...input(),
    });
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.preview_attempts
       set status = 'succeeded', started_at = now(), completed_at = now(),
           output_ref = to_jsonb(
             '{"kind":"inline","value":{"token":"persisted"}}'::text
           )
       where id = $1`,
      [first.previewAttemptId],
    );
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.preview_runs
       set status = 'succeeded', started_at = now(), completed_at = now(),
           output_ref = to_jsonb(
             '{"kind":"inline","value":{"token":"persisted"}}'::text
           )
       where id = $1`,
      [first.previewRunId],
    );
    const second = await apiPreviews.acceptPreview({
      workspaceId: workspaceA,
      ...input({
        input: { kind: 'prior_preview', previewRunId: first.previewRunId },
        keyHash: digest('second-key'),
        requestHash: digest('second-request'),
      }),
    });
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      const [row] = await db
        .select()
        .from(previewRuns)
        .where(eq(previewRuns.id, second.previewRunId));
      expect(row).toMatchObject({
        priorPreviewRunId: first.previewRunId,
        inputRef: {
          kind: 'inline',
          value: { token: 'persisted' },
        },
      });
    });

    await expect(
      apiPreviews.acceptPreview({
        workspaceId: workspaceB,
        ...input({
          workflowId: workflowB,
          input: { kind: 'prior_preview', previewRunId: first.previewRunId },
          keyHash: digest('cross-key'),
          requestHash: digest('cross-request'),
          scope: `workflow:${workflowB}`,
        }),
      }),
    ).rejects.toBeInstanceOf(PriorPreviewInputUnavailableError);

    await expect(
      apiPreviews.acceptPreview({
        workspaceId: workspaceA,
        ...input({
          workflowId: workflowC,
          input: { kind: 'prior_preview', previewRunId: first.previewRunId },
          keyHash: digest('different-workflow-key'),
          requestHash: digest('different-workflow-request'),
          scope: `workflow:${workflowC}`,
        }),
      }),
    ).rejects.toBeInstanceOf(PriorPreviewInputUnavailableError);

    const failed = await apiPreviews.acceptPreview({
      workspaceId: workspaceA,
      ...input({
        keyHash: digest('failed-source-key'),
        requestHash: digest('failed-source-request'),
      }),
    });
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.preview_attempts
          set status = 'failed', started_at = now(), completed_at = now(),
              safe_error_code = 'preview.fixture_failed'
        where id = $1`,
      [failed.previewAttemptId],
    );
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.preview_runs
          set status = 'failed', started_at = now(), completed_at = now(),
              safe_error_code = 'preview.fixture_failed'
        where id = $1`,
      [failed.previewRunId],
    );
    await expect(
      apiPreviews.acceptPreview({
        workspaceId: workspaceA,
        ...input({
          input: { kind: 'prior_preview', previewRunId: failed.previewRunId },
          keyHash: digest('failed-consumer-key'),
          requestHash: digest('failed-consumer-request'),
        }),
      }),
    ).rejects.toBeInstanceOf(PriorPreviewInputUnavailableError);

    const expiring = await apiPreviews.acceptPreview({
      workspaceId: workspaceA,
      ...input({
        expiresAt: new Date(Date.now() + 1_000),
        keyHash: digest('expiring-source-key'),
        requestHash: digest('expiring-source-request'),
      }),
    });
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.preview_attempts
          set status = 'succeeded', started_at = now(), completed_at = now(),
              output_ref = '{"kind":"inline","value":{"expired":true}}'
        where id = $1`,
      [expiring.previewAttemptId],
    );
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.preview_runs
          set status = 'succeeded', started_at = now(), completed_at = now(),
              output_ref = '{"kind":"inline","value":{"expired":true}}'
        where id = $1`,
      [expiring.previewRunId],
    );
    // Expiry is an immutable PostgreSQL acceptance fact, so this intentionally
    // crosses the database clock instead of mutating the protected identity.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(
      apiPreviews.acceptPreview({
        workspaceId: workspaceA,
        ...input({
          input: {
            kind: 'prior_preview',
            previewRunId: expiring.previewRunId,
          },
          keyHash: digest('expired-consumer-key'),
          requestHash: digest('expired-consumer-request'),
        }),
      }),
    ).rejects.toBeInstanceOf(PriorPreviewInputUnavailableError);
  });

  it('hides previews across workspaces and prevents API pin mutation', async () => {
    const accepted = await apiPreviews.acceptPreview({
      workspaceId: workspaceA,
      ...input(),
    });
    await apiDatabase.withWorkspace(workspaceB, async ({ db }) => {
      expect(await db.select().from(previewRuns)).toEqual([]);
      expect(await db.select().from(previewAttempts)).toEqual([]);
    });
    await expect(
      apiDatabase.withWorkspace(workspaceA, ({ db }) =>
        db
          .update(previewRuns)
          .set({ nodeId: 'changed' })
          .where(eq(previewRuns.id, accepted.previewRunId)),
      ),
    ).rejects.toSatisfy((error: unknown) => hasPostgresCode(error, '42501'));
  });
}
