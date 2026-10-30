import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutable,
  buildWorkflowTestExecutable,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine';

import { createWorkflowAuthoringDatabase } from '../../../../src/authoring/workflows/repository.js';

import {
  workspaceId,
  otherWorkspaceId,
} from '../../../support/workflow-authoring.js';
import {
  config,
  database,
  scanner,
  query,
  fixture,
  command,
  due,
  complete,
  runId,
} from './fixture.js';
import { WorkflowNotFoundError } from '../../../../src/authoring/workflows/errors.js';

export function registerRequiresExactEffectAcknowledgementAccepts(): void {
  it('requires exact effect acknowledgement and accepts only one concurrent start', async () => {
    const f = await fixture(1);
    const effectCatalog = composeExecutableCatalog({
      ...CORE_NODE_CATALOG,
      definitions: CORE_NODE_CATALOG.definitions.map((definition) =>
        definition.definition.key === 'core.set'
          ? { ...definition, retryClass: 'unsafe' as const }
          : definition,
      ),
    });
    const effects = createWorkflowAuthoringDatabase(config(), {
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
    });
    try {
      const intent = await command(f);
      const request = { ...intent.request, expectedEffectfulSteps: ['set'] };
      await expect(
        effects.workflowTestSuites.start({ ...intent, request }),
      ).rejects.toMatchObject({ reason: 'effects_acknowledgement_required' });
      await expect(
        effects.workflowTestSuites.start({
          ...intent,
          request: {
            ...request,
            acknowledgeSideEffects: true,
            expectedEffectfulSteps: [],
          },
        }),
      ).rejects.toMatchObject({ reason: 'effects_changed' });
      const results = await Promise.allSettled([
        effects.workflowTestSuites.start({
          ...intent,
          request: { ...request, acknowledgeSideEffects: true },
        }),
        effects.workflowTestSuites.start({
          ...intent,
          idempotencyKey: randomUUID(),
          request: { ...request, acknowledgeSideEffects: true },
        }),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toMatchObject([{ reason: { reason: 'already_running' } }]);
    } finally {
      await effects.close();
    }
  });

  it('keeps case reports private and stops future admissions after cancellation', async () => {
    const f = await fixture();
    const accepted = await database.workflowTestSuites.start(await command(f));
    const first = await database.workflowTestSuites.get({
      ...f.scope,
      ...accepted,
    });
    await expect(
      database.workflowTestSuites.get({
        ...f.scope,
        workspaceId: otherWorkspaceId,
        ...accepted,
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await expect(
      database.workflowTestSuites.report({
        ...f.scope,
        workspaceId: otherWorkspaceId,
        ...accepted,
        ordinal: 0,
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await database.workflowTestSuites.cancel({ ...f.scope, ...accepted });
    await database.workflowTestSuites.cancel({ ...f.scope, ...accepted });
    await complete(runId(first, 0), {}, 'canceled');
    await due(accepted.suiteId);
    await scanner.scan(25);
    expect(
      await database.workflowTestSuites.get({ ...f.scope, ...accepted }),
    ).toMatchObject({
      status: 'canceled',
      stopReason: 'user_canceled',
      skipped: 1,
      cases: [{ status: 'error' }, { status: 'skipped', runId: null }],
    });
    expect(
      (
        await database.workflowTestSuites.report({
          ...f.scope,
          ...accepted,
          ordinal: 0,
        })
      ).report,
    ).toMatchObject({ error: 'run_canceled' });
  });

  it('stops at the suite deadline after settling the accepted case', async () => {
    const f = await fixture();
    const accepted = await database.workflowTestSuites.start(await command(f));
    const first = await database.workflowTestSuites.get({
      ...f.scope,
      ...accepted,
    });
    await query(
      "update app.workflow_test_suites set created_at=clock_timestamp()-interval '6 hours',deadline_at=clock_timestamp()-interval '1 second' where id=$1",
      [accepted.suiteId],
    );
    await complete(runId(first, 0), { amount: 1 });
    await due(accepted.suiteId);
    await scanner.scan(25);
    expect(
      await database.workflowTestSuites.get({ ...f.scope, ...accepted }),
    ).toMatchObject({
      status: 'error',
      stopReason: 'deadline_exceeded',
      passed: 1,
      skipped: 1,
    });
  });

  it('retries a full queue without accepting a duplicate or losing the completed report', async () => {
    const f = await fixture();
    const accepted = await database.workflowTestSuites.start(await command(f));
    const first = await database.workflowTestSuites.get({
      ...f.scope,
      ...accepted,
    });
    const previous = (
      await query<{ current_version: number }>(
        'select current_version from app.workspace_execution_entitlements where workspace_id=$1',
        [workspaceId],
      )
    )[0];
    if (previous === undefined) throw new Error('Missing entitlement');
    await query(
      'insert into app.workspace_execution_entitlement_versions(workspace_id,version,status,active_run_limit,queued_run_limit) select workspace_id,version+1,status,active_run_limit,1 from app.workspace_execution_entitlement_versions where workspace_id=$1 and version=$2',
      [workspaceId, previous.current_version],
    );
    await query(
      'update app.workspace_execution_entitlements set current_version=current_version+1 where workspace_id=$1',
      [workspaceId],
    );
    try {
      await complete(runId(first, 0), { amount: 1 });
      await due(accepted.suiteId);
      await scanner.scan(25);
      expect(
        await database.workflowTestSuites.get({ ...f.scope, ...accepted }),
      ).toMatchObject({
        status: 'running',
        passed: 1,
        cases: [{ status: 'passed' }, { status: 'pending', runId: null }],
      });
    } finally {
      await query(
        'update app.workspace_execution_entitlements set current_version=$2 where workspace_id=$1',
        [workspaceId, previous.current_version],
      );
    }
    await due(accepted.suiteId);
    await scanner.scan(25);
    const next = await database.workflowTestSuites.get({
      ...f.scope,
      ...accepted,
    });
    expect(next.cases.map((entry) => entry.status)).toEqual([
      'passed',
      'running',
    ]);
    await complete(runId(next, 1), { amount: 2 });
    await due(accepted.suiteId);
    await scanner.scan(25);
    expect(
      await database.workflowTestSuites.get({ ...f.scope, ...accepted }),
    ).toMatchObject({ status: 'passed' });
  });
}
