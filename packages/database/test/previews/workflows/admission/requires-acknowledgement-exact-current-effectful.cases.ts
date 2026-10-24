import { WorkflowRunNotExecutableError } from '../../../../src/runs/errors.js';

import { lockReplaySource } from '../../../../src/runs/commands/replay.repository.js';
import { expect, it } from 'vitest';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutable,
  buildWorkflowTestExecutable,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine';

import { createWorkflowAuthoringDatabase } from '../../../../src/authoring/workflows/repository.js';
import { parseDatabaseConfig } from '../../../../src/config.js';

import {
  apiUrl,
  actorId,
  workspaceId,
  enforceTestRetention,
  randomUUID,
} from '../../../support/workflow-authoring.js';
import {
  query,
  execute,
  runs,
  workspaceDatabase,
  database,
  reader,
  fixture,
  command,
} from './fixture.js';

export function registerRequiresAcknowledgementExactCurrentEffectful(): void {
  it('requires acknowledgement of the exact current effectful steps under the admission locks', async () => {
    const f = await fixture();
    const effectCatalog = composeExecutableCatalog({
      ...CORE_NODE_CATALOG,
      definitions: CORE_NODE_CATALOG.definitions.map((definition) =>
        definition.definition.key === 'core.set'
          ? { ...definition, retryClass: 'unsafe' as const }
          : definition,
      ),
    });
    const effects = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
      {
        executableCompiler: (graph) => {
          const executable = buildWorkflowExecutable({
            graph,
            catalog: effectCatalog,
          });
          return {
            checksum: executable.checksum,
            executableJson: executable.envelope,
          };
        },
        workflowTestCompiler: (graph, pins) =>
          buildWorkflowTestExecutable({ graph, pins, catalog: effectCatalog }),
      },
    );
    try {
      const preparation = await effects.workflowTests.prepare(f.scope);
      expect(preparation.effectfulSteps).toEqual([
        { nodeId: 'set', label: 'core.set' },
      ]);
      const intent = {
        ...(await command(f)),
        request: {
          ...(await command(f)).request,
          expectedEffectfulSteps: ['set'],
        },
      };
      await expect(effects.workflowTests.start(intent)).rejects.toMatchObject({
        reason: 'effects_acknowledgement_required',
      });
      await expect(
        effects.workflowTests.start({
          ...intent,
          request: {
            ...intent.request,
            acknowledgeSideEffects: true,
            expectedEffectfulSteps: [],
          },
        }),
      ).rejects.toMatchObject({ reason: 'effects_changed' });
      expect((await effects.workflowTests.list(f.scope)).items).toEqual([]);
      const accepted = await effects.workflowTests.start({
        ...intent,
        request: { ...intent.request, acknowledgeSideEffects: true },
      });
      expect(accepted.runId).toBeTruthy();
    } finally {
      await effects.close();
    }
  });

  it('hides expired tests before maintenance and removes their frozen payloads and execution details', async () => {
    const f = await fixture();
    const accepted = await database.workflowTests.start(await command(f));
    await execute(
      `update app.workflow_runs set status='failed',created_at=clock_timestamp()-interval '8 days',completed_at=clock_timestamp()-interval '8 days',input_ref_expires_at=clock_timestamp()-interval '1 day' where id=$1`,
      [accepted.runId],
    );
    await execute(
      `update app.workflow_test_snapshots set expires_at=clock_timestamp()-interval '1 day' where id=$1`,
      [accepted.runId],
    );
    expect(
      await runs.readInput({
        actorId: actorId,
        workspaceId,
        runId: accepted.runId,
      }),
    ).toEqual({ kind: 'expired' });
    expect(
      await runs.get({ actorId: actorId, workspaceId, runId: accepted.runId }),
    ).toBeUndefined();
    expect(
      await runs.readVariables({
        actorId: actorId,
        workspaceId,
        runId: accepted.runId,
      }),
    ).toBeNull();
    expect((await database.workflowTests.list(f.scope)).items).toEqual([]);
    await expect(
      database.workflowTests.get({ ...f.scope, ...accepted }),
    ).rejects.toMatchObject({ reason: 'not_found' });
    // Private workers retain the execution source until they can settle interrupted tests.
    expect(
      await reader.readForExecution({
        workspaceId,
        workflowVersionId: accepted.runId,
      }),
    ).not.toBeNull();
    const removed = await enforceTestRetention(2);
    expect(removed.workflow_test_snapshots).toBe(1);
    expect(
      await reader.readForExecution({
        workspaceId,
        workflowVersionId: accepted.runId,
      }),
    ).toBeNull();
    expect(
      (
        await query<{ count: string }>(
          'select count(*) from app.run_checkpoints where workflow_run_id=$1',
          [accepted.runId],
        )
      )[0]?.count,
    ).toBe('0');
    expect(
      (
        await query<{ input_ref: unknown }>(
          'select input_ref from app.workflow_runs where id=$1',
          [accepted.runId],
        )
      )[0]?.input_ref ?? null,
    ).toBeNull();
  });

  it('refuses a draft test as the source of published replay or recovery', async () => {
    const f = await fixture();
    const accepted = await database.workflowTests.start(await command(f));
    await expect(
      workspaceDatabase.withWorkspace(workspaceId, (transaction) =>
        lockReplaySource(transaction, accepted.runId),
      ),
    ).rejects.toBeInstanceOf(WorkflowRunNotExecutableError);
  });

  it('uses the existing queued-run quota and rolls back a refused test atomically', async () => {
    const f = await fixture();
    const intent = await command(f);
    const previous = (
      await query<{ current_version: number }>(
        'select current_version from app.workspace_execution_entitlements where workspace_id=$1',
        [workspaceId],
      )
    )[0];
    if (previous === undefined)
      throw new Error('Expected workspace entitlement');
    await execute(
      `insert into app.workspace_execution_entitlement_versions(workspace_id,version,status,active_run_limit,queued_run_limit) select workspace_id,version+1,status,active_run_limit,1 from app.workspace_execution_entitlement_versions where workspace_id=$1 and version=$2`,
      [workspaceId, previous.current_version],
    );
    await execute(
      'update app.workspace_execution_entitlements set current_version=current_version+1 where workspace_id=$1',
      [workspaceId],
    );
    try {
      await expect(database.workflowTests.start(intent)).rejects.toThrow(
        'workspace.quota_exceeded',
      );
      expect((await database.workflowTests.list(f.scope)).items).toEqual([]);
    } finally {
      await execute(
        'update app.workspace_execution_entitlements set current_version=$2 where workspace_id=$1',
        [workspaceId, previous.current_version],
      );
    }
  });

  it('freezes dense numeric pins without JSONB expansion and reads back their exact value', async () => {
    const f = await fixture();
    const output = { values: Array.from({ length: 9990 }, () => 1e300) };
    await database.stepSamples.put({
      ...f.scope,
      nodeId: 'set',
      expectedDraftRevision: 1,
      expectedSampleId: null,
      idempotencyKey: randomUUID(),
      source: { kind: 'json', value: output },
    });
    const accepted = await database.workflowTests.start(await command(f));
    const stored = (
      await query<{ bytes: number }>(
        'select octet_length(pins::text) bytes from app.workflow_test_snapshots where id=$1',
        [accepted.runId],
      )
    )[0];
    expect(stored?.bytes).toBeLessThanOrEqual(2 * 262144);
    expect(
      (
        await reader.readForExecution({
          workspaceId,
          workflowVersionId: accepted.runId,
          nodeId: 'set',
        })
      )?.testSample?.output,
    ).toEqual(output);
  });
}
