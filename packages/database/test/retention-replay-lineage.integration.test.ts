import { describe, expect, it, vi } from 'vitest';

import {
  type ControlLedger,
  createRetentionEnforcementCoordinator,
  cutoffAt,
  maintenanceUrl,
  owner,
  Pool,
  parseDatabaseConfig,
  randomUUID,
  retention,
  userId,
  workspaceId,
  zeroHash,
} from './support/retention.integration.support.js';

type RunFixture = Readonly<{
  completedAt?: string | null;
  createdAt?: string;
  detailsPurgedAt?: string | null;
  id: string;
  replayCommandId?: string | null;
  replaySourceRunId?: string | null;
  status?: 'running' | 'succeeded';
  triggerType?: 'manual' | 'replay';
  workspaceId: string;
}>;

async function withOwner<T>(
  scopedWorkspaceId: string,
  operation: (client: typeof owner) => Promise<T>,
): Promise<T> {
  await owner.query('begin');
  try {
    await owner.query('set local role pertexo_owner');
    await owner.query("select set_config('app.workspace_id',$1,true)", [
      scopedWorkspaceId,
    ]);
    const result = await operation(owner);
    await owner.query('commit');
    return result;
  } catch (error: unknown) {
    await owner.query('rollback').catch(() => undefined);
    throw error;
  }
}

async function createWorkspaceFixture(scopedWorkspaceId: string) {
  await withOwner(scopedWorkspaceId, async (client) => {
    await client.query(
      `insert into app.workspaces(id,name,slug,created_by)
       values($1,'Replay lineage fixture',$2,$3)`,
      [scopedWorkspaceId, `replay-lineage-${scopedWorkspaceId}`, userId],
    );
  });
}

async function insertRunFixtures(runs: readonly RunFixture[]) {
  const first = runs[0];
  if (first === undefined) throw new Error('At least one run is required');
  await withOwner(first.workspaceId, async (client) => {
    await client.query(
      'alter table app.workflow_runs no force row level security',
    );
    for (const run of runs) {
      await client.query("select set_config('app.workspace_id',$1,true)", [
        run.workspaceId,
      ]);
      const createdAt =
        run.createdAt ?? run.completedAt ?? '2026-01-01T00:00:00Z';
      await client.query(
        `insert into app.workflow_runs
          (id,workspace_id,workflow_id,workflow_version_id,
           replay_source_run_id,replay_command_id,trigger_type,status,
           completed_at,details_purged_at,created_at,updated_at)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
        [
          run.id,
          run.workspaceId,
          randomUUID(),
          randomUUID(),
          run.replaySourceRunId ?? null,
          run.replayCommandId ?? null,
          run.triggerType ?? 'manual',
          run.status ?? 'succeeded',
          run.completedAt ?? null,
          run.detailsPurgedAt ?? null,
          createdAt,
        ],
      );
    }
    await client.query(
      'alter table app.workflow_runs force row level security',
    );
  });
}

async function countRuns(
  scopedWorkspaceId: string,
  runIds: readonly string[],
): Promise<number> {
  return withOwner(scopedWorkspaceId, async (client) => {
    await client.query(
      'alter table app.workflow_runs no force row level security',
    );
    const result = await client.query<{ id: string }>(
      `select id from app.workflow_runs
       where workspace_id=$1 and id=any($2::uuid[])`,
      [scopedWorkspaceId, runIds],
    );
    await client.query(
      'alter table app.workflow_runs force row level security',
    );
    return result.rows.length;
  });
}

async function readBatch(
  scopedWorkspaceId: string,
  batchId: string,
): Promise<{
  eligible_count: string;
  examined_count: string;
  pause_reason: string | null;
  status: string;
}> {
  return withOwner(scopedWorkspaceId, async (client) => {
    const result = await client.query<{
      eligible_count: string;
      examined_count: string;
      pause_reason: string | null;
      status: string;
    }>(
      `select status,pause_reason,eligible_count,examined_count
       from app.retention_batches where id=$1`,
      [batchId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('Retention batch was not found');
    return row;
  });
}

function ledger(): ControlLedger {
  type ReconcileInput = Parameters<ControlLedger['reconcile']>[0];
  return {
    append: vi.fn(),
    reconcile: vi.fn((input: ReconcileInput) =>
      Promise.resolve({
        hasMore: false,
        pageEndHash: input.projectedHash,
        pageEndSequence: input.projectedSequence,
        reachedHighWater: true,
        records: [],
      }),
    ),
  };
}

function coordinator(
  leaseOwner: string,
  options: Readonly<{
    maxPagesPerBatch?: number;
    pageSize?: number;
  }> = {},
) {
  return createRetentionEnforcementCoordinator(
    parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
    ledger(),
    {
      leaseOwner,
      leaseSeconds: 60,
      ...options,
    },
  );
}

async function startSummaryBatch(
  scopedWorkspaceId: string,
  summaryCutoffAt: Date,
): Promise<string> {
  const batchId = randomUUID();
  await retention.startEnforcement({
    batchId,
    cutoffAt: summaryCutoffAt,
    idempotencyKey: `retention-replay-lineage-${batchId}`,
    reason: 'preserve replay lineage during summary retention',
    requestedBy: 'integration-operator',
    retentionKind: 'run_summary',
    workspaceId: scopedWorkspaceId,
  });
  return batchId;
}

async function placeLegalHold(
  scopedWorkspaceId: string,
  recordHash: string,
): Promise<void> {
  const maintenance = new Pool({ connectionString: maintenanceUrl, max: 1 });
  try {
    await maintenance.query(
      `select app.project_workspace_legal_hold(
        $1,1,$2,'legal_hold_placed',$3,$4,$5,
        'legal-admin','case-replay','preserve replay evidence',$6)`,
      [
        scopedWorkspaceId,
        randomUUID(),
        randomUUID(),
        zeroHash,
        recordHash,
        '2026-08-21T00:00:00Z',
      ],
    );
  } finally {
    await maintenance.end();
  }
}

describe('retention replay lineage', () => {
  it('reports replay-protected sources in dry-run inventory without deleting them', async () => {
    const lineageWorkspaceId = randomUUID();
    const oldSourceRunId = randomUUID();
    const newRunId = randomUUID();
    const activeChildRunId = randomUUID();
    await createWorkspaceFixture(lineageWorkspaceId);
    await insertRunFixtures([
      {
        id: oldSourceRunId,
        workspaceId: lineageWorkspaceId,
        completedAt: '2026-01-01T00:00:00Z',
        detailsPurgedAt: '2026-01-02T00:00:00Z',
      },
      {
        id: newRunId,
        workspaceId: lineageWorkspaceId,
        completedAt: '2026-05-20T00:00:00Z',
        detailsPurgedAt: '2026-05-21T00:00:00Z',
      },
      {
        id: activeChildRunId,
        workspaceId: lineageWorkspaceId,
        triggerType: 'replay',
        status: 'running',
        replaySourceRunId: oldSourceRunId,
        replayCommandId: randomUUID(),
        createdAt: '2026-07-01T00:00:00Z',
      },
    ]);

    const firstBatchId = randomUUID();
    await expect(
      retention.startDryRun({
        batchId: firstBatchId,
        cutoffAt: new Date('2026-08-01T00:00:00Z'),
        idempotencyKey: `retention-replay-lineage-dry-run-${firstBatchId}`,
        reason: 'inventory replay-protected retention sources',
        requestedBy: 'integration-operator',
        retentionKind: 'run_summary',
        workspaceId: lineageWorkspaceId,
      }),
    ).resolves.toBe(firstBatchId);
    await expect(retention.processNext()).resolves.toMatchObject({
      batchId: firstBatchId,
      eligibleCount: 0,
      examinedCount: 1,
      pageCount: 1,
      retentionKind: 'run_summary',
      status: 'completed',
      workspaceId: lineageWorkspaceId,
    });
    await expect(
      readBatch(lineageWorkspaceId, firstBatchId),
    ).resolves.toMatchObject({
      eligible_count: '0',
      examined_count: '1',
      status: 'completed',
    });
    await expect(
      countRuns(lineageWorkspaceId, [
        oldSourceRunId,
        newRunId,
        activeChildRunId,
      ]),
    ).resolves.toBe(3);

    await withOwner(lineageWorkspaceId, async (client) => {
      await client.query(
        `update app.workflow_runs
         set status='succeeded',completed_at=$2,details_purged_at=$3,updated_at=$3
         where workspace_id=$1 and id=$4`,
        [
          lineageWorkspaceId,
          '2026-05-25T00:00:00Z',
          '2026-05-26T00:00:00Z',
          activeChildRunId,
        ],
      );
    });

    const secondBatchId = randomUUID();
    await expect(
      retention.startDryRun({
        batchId: secondBatchId,
        cutoffAt: new Date('2026-09-01T00:00:00Z'),
        idempotencyKey: `retention-replay-lineage-dry-run-${secondBatchId}`,
        reason: 'inventory replay lineage after child completion',
        requestedBy: 'integration-operator',
        retentionKind: 'run_summary',
        workspaceId: lineageWorkspaceId,
      }),
    ).resolves.toBe(secondBatchId);
    await expect(retention.processNext()).resolves.toMatchObject({
      batchId: secondBatchId,
      eligibleCount: 2,
      examinedCount: 3,
      pageCount: 2,
      retentionKind: 'run_summary',
      status: 'completed',
      workspaceId: lineageWorkspaceId,
    });
    await expect(
      readBatch(lineageWorkspaceId, secondBatchId),
    ).resolves.toMatchObject({
      eligible_count: '2',
      examined_count: '3',
      status: 'completed',
    });
    await expect(
      countRuns(lineageWorkspaceId, [
        oldSourceRunId,
        newRunId,
        activeChildRunId,
      ]),
    ).resolves.toBe(3);
  });

  it('uses the default page size while preserving active replay sources and tenant isolation', async () => {
    const unrelatedWorkspaceId = randomUUID();
    const sourceRunId = randomUUID();
    const activeReplayRunId = randomUUID();
    const unrelatedRunId = randomUUID();
    await createWorkspaceFixture(unrelatedWorkspaceId);
    await insertRunFixtures([
      {
        id: sourceRunId,
        workspaceId,
        completedAt: '2026-01-01T00:00:00Z',
        detailsPurgedAt: '2026-01-02T00:00:00Z',
      },
      {
        id: activeReplayRunId,
        workspaceId,
        triggerType: 'replay',
        status: 'running',
        replaySourceRunId: sourceRunId,
        replayCommandId: randomUUID(),
        createdAt: '2026-07-01T00:00:00Z',
      },
      {
        id: unrelatedRunId,
        workspaceId: unrelatedWorkspaceId,
        completedAt: '2026-01-01T00:00:00Z',
        detailsPurgedAt: '2026-01-02T00:00:00Z',
      },
    ]);

    const activeBatchId = await startSummaryBatch(workspaceId, cutoffAt);
    const activeCoordinator = coordinator('retention-replay-active-default');
    try {
      await expect(activeCoordinator.processNext()).resolves.toMatchObject({
        batchId: activeBatchId,
        eligibleCount: 0,
        examinedCount: 0,
        pageCount: 1,
        retentionKind: 'run_summary',
        status: 'completed',
        workspaceId,
      });

      const unrelatedBatchId = await startSummaryBatch(
        unrelatedWorkspaceId,
        cutoffAt,
      );
      await expect(activeCoordinator.processNext()).resolves.toMatchObject({
        batchId: unrelatedBatchId,
        eligibleCount: 1,
        examinedCount: 1,
        pageCount: 2,
        retentionKind: 'run_summary',
        status: 'completed',
        workspaceId: unrelatedWorkspaceId,
      });
    } finally {
      await activeCoordinator.close();
    }

    await expect(
      countRuns(workspaceId, [sourceRunId, activeReplayRunId]),
    ).resolves.toBe(2);
    await expect(
      countRuns(unrelatedWorkspaceId, [unrelatedRunId]),
    ).resolves.toBe(0);
  });

  it('walks a replay chain across page boundaries and deletes ancestors after descendants expire', async () => {
    const sourceRunId = randomUUID();
    const replayRunId = randomUUID();
    const nestedReplayRunId = randomUUID();
    await insertRunFixtures([
      {
        id: sourceRunId,
        workspaceId,
        completedAt: '2026-01-01T00:00:00Z',
        detailsPurgedAt: '2026-01-02T00:00:00Z',
      },
      {
        id: replayRunId,
        workspaceId,
        triggerType: 'replay',
        replaySourceRunId: sourceRunId,
        replayCommandId: randomUUID(),
        completedAt: '2026-05-20T00:00:00Z',
        detailsPurgedAt: '2026-05-21T00:00:00Z',
      },
      {
        id: nestedReplayRunId,
        workspaceId,
        triggerType: 'replay',
        replaySourceRunId: replayRunId,
        replayCommandId: randomUUID(),
        completedAt: '2026-05-25T00:00:00Z',
        detailsPurgedAt: '2026-05-26T00:00:00Z',
      },
    ]);

    const firstBatchId = await startSummaryBatch(
      workspaceId,
      new Date('2026-08-01T00:00:00Z'),
    );
    const chainCoordinator = coordinator('retention-replay-chain', {
      maxPagesPerBatch: 10,
      pageSize: 1,
    });
    try {
      await expect(chainCoordinator.processNext()).resolves.toMatchObject({
        batchId: firstBatchId,
        eligibleCount: 0,
        examinedCount: 0,
        pageCount: 1,
        retentionKind: 'run_summary',
        status: 'completed',
        workspaceId,
      });
      await expect(
        countRuns(workspaceId, [sourceRunId, replayRunId, nestedReplayRunId]),
      ).resolves.toBe(3);

      const secondBatchId = await startSummaryBatch(
        workspaceId,
        new Date('2026-09-01T00:00:00Z'),
      );
      await expect(chainCoordinator.processNext()).resolves.toMatchObject({
        batchId: secondBatchId,
        eligibleCount: 3,
        examinedCount: 3,
        pageCount: 4,
        retentionKind: 'run_summary',
        status: 'completed',
        workspaceId,
      });
    } finally {
      await chainCoordinator.close();
    }

    await expect(
      countRuns(workspaceId, [sourceRunId, replayRunId, nestedReplayRunId]),
    ).resolves.toBe(0);
  });

  it('pauses a replay-source page under a legal hold without touching another tenant', async () => {
    const heldWorkspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const heldSourceRunId = randomUUID();
    const heldReplayRunId = randomUUID();
    const otherRunId = randomUUID();
    await createWorkspaceFixture(heldWorkspaceId);
    await createWorkspaceFixture(otherWorkspaceId);
    await insertRunFixtures([
      {
        id: heldSourceRunId,
        workspaceId: heldWorkspaceId,
        completedAt: '2026-01-01T00:00:00Z',
        detailsPurgedAt: '2026-01-02T00:00:00Z',
      },
      {
        id: heldReplayRunId,
        workspaceId: heldWorkspaceId,
        triggerType: 'replay',
        replaySourceRunId: heldSourceRunId,
        replayCommandId: randomUUID(),
        createdAt: '2026-07-01T00:00:00Z',
      },
      {
        id: otherRunId,
        workspaceId: otherWorkspaceId,
        completedAt: '2026-01-01T00:00:00Z',
        detailsPurgedAt: '2026-01-02T00:00:00Z',
      },
    ]);
    const heldBatchId = await startSummaryBatch(heldWorkspaceId, cutoffAt);
    const otherBatchId = await startSummaryBatch(otherWorkspaceId, cutoffAt);
    await placeLegalHold(heldWorkspaceId, 'b'.repeat(64));

    const holdCoordinator = coordinator('retention-replay-legal-hold');
    try {
      await expect(holdCoordinator.processNext()).resolves.toMatchObject({
        batchId: heldBatchId,
        eligibleCount: 0,
        examinedCount: 0,
        pageCount: 1,
        retentionKind: 'run_summary',
        status: 'paused',
        workspaceId: heldWorkspaceId,
      });
      await expect(holdCoordinator.processNext()).resolves.toMatchObject({
        batchId: otherBatchId,
        eligibleCount: 1,
        examinedCount: 1,
        pageCount: 2,
        retentionKind: 'run_summary',
        status: 'completed',
        workspaceId: otherWorkspaceId,
      });
    } finally {
      await holdCoordinator.close();
    }

    await expect(
      readBatch(heldWorkspaceId, heldBatchId),
    ).resolves.toMatchObject({
      eligible_count: '0',
      examined_count: '0',
      pause_reason: 'legal_hold',
      status: 'paused',
    });
    await expect(
      countRuns(heldWorkspaceId, [heldSourceRunId, heldReplayRunId]),
    ).resolves.toBe(2);
    await expect(countRuns(otherWorkspaceId, [otherRunId])).resolves.toBe(0);
  });

  it('completes a source-only summary page after the replay child becomes eligible', async () => {
    const sourceRunId = randomUUID();
    const replayRunId = randomUUID();
    await insertRunFixtures([
      {
        id: sourceRunId,
        workspaceId,
        completedAt: '2026-01-01T00:00:00Z',
        detailsPurgedAt: '2026-01-02T00:00:00Z',
      },
      {
        id: replayRunId,
        workspaceId,
        triggerType: 'replay',
        replaySourceRunId: sourceRunId,
        replayCommandId: randomUUID(),
        completedAt: '2026-05-20T00:00:00Z',
        detailsPurgedAt: '2026-05-21T00:00:00Z',
      },
    ]);
    const blockedBatchId = await startSummaryBatch(
      workspaceId,
      new Date('2026-08-01T00:00:00Z'),
    );
    const eventualCoordinator = coordinator('retention-replay-eventual', {
      maxPagesPerBatch: 10,
      pageSize: 1,
    });
    try {
      await expect(eventualCoordinator.processNext()).resolves.toMatchObject({
        batchId: blockedBatchId,
        eligibleCount: 0,
        examinedCount: 0,
        pageCount: 1,
        retentionKind: 'run_summary',
        status: 'completed',
        workspaceId,
      });

      const eligibleBatchId = await startSummaryBatch(
        workspaceId,
        new Date('2026-09-01T00:00:00Z'),
      );
      await expect(eventualCoordinator.processNext()).resolves.toMatchObject({
        batchId: eligibleBatchId,
        eligibleCount: 2,
        examinedCount: 2,
        pageCount: 3,
        retentionKind: 'run_summary',
        status: 'completed',
        workspaceId,
      });
    } finally {
      await eventualCoordinator.close();
    }
    await expect(
      countRuns(workspaceId, [sourceRunId, replayRunId]),
    ).resolves.toBe(0);
  });
});
