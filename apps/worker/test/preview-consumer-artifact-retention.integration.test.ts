import {
  createDualRegionArtifactStore,
  parseDualRegionArtifactStoreConfig,
} from '@pertexo/artifact-store';
import {
  canonicalOutboxPayloadChecksum,
  claimPreviewDelivery,
  completePreviewAttempt,
  createPreviewRetentionCoordinator,
  parseDatabaseConfig,
  PREVIEW_STATUS,
  withTenantScopedClient,
  type ControlLedger,
} from '@pertexo/database/testing';
import { describe, expect, it } from 'vitest';

import { createWorkerNodeRuntimeCapabilities } from '../src/execution/node-runtime-capabilities.js';
import {
  acceptanceInput,
  artifactStoreIntegrationEnabled,
  databaseUrl,
  maintenanceUrl,
  validTraceparent,
  waitFor,
  withTenantAccept,
  workerPool,
  workerTransportIntegrationEnabled,
  workerUrl,
  workspaceId,
} from './support/preview-consumer.integration.support.js';

const describeIntegration = workerTransportIntegrationEnabled
  ? describe
  : describe.skip;
const itArtifactIntegration = artifactStoreIntegrationEnabled ? it : it.skip;

describeIntegration('preview artifact retention transport', () => {
  itArtifactIntegration(
    'removes an expired preview and its object through the real maintenance path',
    async () => {
      const artifactConfig = parseDualRegionArtifactStoreConfig(process.env);
      const previewDeadline = new Date(Date.now() + 2_000);
      const traceparent = validTraceparent;
      const accepted = await withTenantAccept(
        acceptanceInput(traceparent, {
          executionDeadlineAt: previewDeadline,
          expiresAt: previewDeadline,
        }),
      );
      const capabilities = await createWorkerNodeRuntimeCapabilities({
        artifactStore: artifactConfig,
        database: parseDatabaseConfig({
          connectionString: databaseUrl(workerUrl),
        }),
      });
      const verifier = createDualRegionArtifactStore(
        artifactConfig.primary,
        artifactConfig.recovery,
      );
      const artifacts = capabilities.factories.artifacts?.({
        artifactRetentionDeadline: previewDeadline,
        attemptId: accepted.previewAttemptId,
        attemptNumber: 1,
        invocationKey: 'preview:node-1',
        nodeId: 'node-1',
        nodeRunId: accepted.previewRunId,
        previewRunId: accepted.previewRunId,
        runId: accepted.previewRunId,
        workerId: 'preview-cleanup-integration',
        workspaceId,
      });
      if (artifacts === undefined)
        throw new Error('preview artifact capability missing');
      const reference = await artifacts.write({
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield new TextEncoder().encode('preview cleanup proof');
        })(),
        maxBytes: 1_024,
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: new AbortController().signal,
      });
      const executionPayload = {
        schemaVersion: 1 as const,
        workspaceId,
        outboxEventId: accepted.outboxEventId,
        previewRunId: accepted.previewRunId,
        previewAttemptId: accepted.previewAttemptId,
        traceparent,
      };
      const workerId = 'preview-cleanup-integration';
      const claimed = await claimPreviewDelivery(workerPool, {
        delivery: {
          outboxEventId: accepted.outboxEventId,
          payloadChecksum: canonicalOutboxPayloadChecksum(executionPayload),
        },
        leaseDurationSeconds: 30,
        previewAttemptId: accepted.previewAttemptId,
        previewRunId: accepted.previewRunId,
        workerId,
        workspaceId,
      });
      if (claimed.kind !== 'claimed')
        throw new Error('preview cleanup terminal claim missing');
      await completePreviewAttempt(workerPool, {
        delivery: {
          outboxEventId: accepted.outboxEventId,
          payloadChecksum: canonicalOutboxPayloadChecksum(executionPayload),
        },
        lease: claimed.lease,
        outcome: {
          safeErrorCode: 'preview.cleanup_fixture',
          status: PREVIEW_STATUS.failed,
        },
        workerId,
      });
      const ledger: ControlLedger = {
        append: () => Promise.reject(new Error('cleanup must not append')),
        reconcile: (request) =>
          Promise.resolve({
            hasMore: false,
            pageEndHash: request.projectedHash,
            pageEndSequence: request.projectedSequence,
            reachedHighWater: true,
            records: [],
          }),
      };
      const cleanup = createPreviewRetentionCoordinator(
        parseDatabaseConfig({
          connectionString: databaseUrl(maintenanceUrl),
        }),
        ledger,
        verifier,
        { artifactQuiescenceSeconds: 1 },
      );
      try {
        await expect(
          verifier.head({ artifactId: reference.artifactId, workspaceId }),
        ).resolves.toMatchObject({ artifactId: reference.artifactId });
        // The cleanup process and artifact ledger use independent real clocks;
        // this wait proves the cross-process quiescence deadline.
        await new Promise<void>((resolve) =>
          setTimeout(
            resolve,
            Math.max(0, previewDeadline.getTime() - Date.now() + 1_100),
          ),
        );
        const outcomes: string[] = [];
        await waitFor(
          async () => {
            const result = await cleanup.processNext();
            outcomes.push(result.status);
            return withTenantScopedClient(
              workerPool,
              { workspaceId },
              (client) =>
                client.query<{ count: string }>(
                  `select count(*)::text as count from app.preview_runs
                   where workspace_id=$1 and id=$2`,
                  [workspaceId, accepted.previewRunId],
                ),
            ).then((result) => result.rows[0]?.count ?? 'missing');
          },
          (count) => count === '0',
        );
        expect(outcomes).toContain('completed');
        await expect(
          verifier.head({ artifactId: reference.artifactId, workspaceId }),
        ).resolves.toBeNull();
      } finally {
        await Promise.allSettled([cleanup.close(), capabilities.close()]);
        await verifier
          .delete({ artifactId: reference.artifactId, workspaceId })
          .catch(() => undefined);
        verifier.close();
      }
    },
  );
});
