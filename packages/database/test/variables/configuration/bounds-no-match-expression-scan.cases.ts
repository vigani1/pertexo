import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  canonicalJson,
  workspaceVariableValuesSchema,
} from '@pertexo/workflow-model';
import { createCheckpoint } from '@pertexo/workflow-engine';
import type { WorkflowGraph } from '@pertexo/workflow-model';

import { WorkspaceVariableUsageChangedError } from '../../../src/variables/contract.js';

import { RunVariableSnapshotUnavailableError } from '../../../src/runs/commands/variables.repository.js';
import { createWorkflowRunDatabase } from '../../../src/runs/runs.repository.js';

import { admin } from '../../lifecycle/calls/fixtures.js';
import { userId } from '../../lifecycle/retention.support.js';
import {
  config,
  store,
  fixture,
  scope,
  hash,
  admit,
  snapshot,
} from './fixture.js';

export function registerBoundsNoMatchExpressionScan(): void {
  it('bounds a no-match expression scan, continues to real references and rejects a changed source cursor', async () => {
    const f = await fixture();
    const workflowId = [f.parentWorkflowId, f.childWorkflowId].sort()[0];
    if (workflowId === undefined) throw new Error('Workflow missing');
    const node = (id: string, key: string) => ({
      id,
      definition: { key, version: 1 },
      configVersion: 1,
      config: {},
      position: { x: 0, y: 0 },
      inputMappings: {},
      connectionRefs: {},
    });
    const mappings = Object.fromEntries(
      Array.from({ length: 105 }, (_, index) => [
        `N${String(index).padStart(3, '0')}`,
        {
          kind: 'expression' as const,
          language: 'jsonata' as const,
          expression: '"unrelated"',
        },
      ]),
    );
    const graph: WorkflowGraph = {
      settings: {},
      nodes: [
        {
          ...node('values', 'core.set'),
          inputMappings: {
            ...mappings,
            currency: { kind: 'workspace_variable', name: 'CURRENCY' },
            optional: {
              kind: 'expression',
              language: 'jsonata',
              expression: '$lookup($vars,runInput.name)',
            },
            literal: { kind: 'literal', value: '$vars.FAKE' },
          },
        },
      ],
      edges: [],
    };
    await admin.query(
      'insert into app.workflow_drafts(workspace_id,workflow_id,graph_json,updated_by) values($1,$2,$3::jsonb,$4)',
      [f.workspaceId, workflowId, JSON.stringify(graph), userId],
    );
    const first = await store.usage({
      ...scope(f.workspaceId),
      name: 'CURRENCY',
      limit: 25,
    });
    expect(first.items).toEqual([]);
    expect(first.next?.offset).toBe(100);
    if (first.next === null) throw new Error('Expected continuation');
    const next = await store.usage({
      ...scope(f.workspaceId),
      name: 'CURRENCY',
      limit: 25,
      after: first.next,
    });
    expect(next.items.map((item) => item.kind)).toEqual(['direct', 'dynamic']);
    expect(new Set(next.items.map((item) => item.id)).size).toBe(2);
    await admin.query(
      'update app.workflow_drafts set revision=revision+1 where workflow_id=$1',
      [workflowId],
    );
    await expect(
      store.usage({
        ...scope(f.workspaceId),
        name: 'CURRENCY',
        limit: 25,
        after: first.next,
      }),
    ).rejects.toBeInstanceOf(WorkspaceVariableUsageChangedError);
  });

  it('keeps the fixed empty revision on replay after configuration is first added', async () => {
    const f = await fixture();
    const source = await admit(f);
    await store.replace({
      ...scope(f.workspaceId),
      idempotencyKey: randomUUID(),
      expectedRevision: 0,
      values: { RATE: 20 },
    });
    const runs = createWorkflowRunDatabase(config());
    try {
      const command = {
        ...scope(f.workspaceId),
        sourceRunId: source.runId,
        workflowVersionId: f.parentVersionId,
        input: {},
        idempotencyKeyHash: hash(),
        requestHash: hash(),
        scope: `workflow:${f.parentWorkflowId}:replay`,
        checkpointFactory: (version: { id: string }) => ({
          checkpoint: createCheckpoint({
            workflowVersionId: version.id,
            iterationBudget: 200,
            nextEventSequence: 2,
          }),
        }),
      };
      const replay = await runs.replay(command);
      expect(await snapshot(replay.run.id)).toEqual({
        revision: 0,
        values: {},
      });
      expect(
        await runs.readVariables({
          actorId: userId,
          workspaceId: f.workspaceId,
          runId: replay.run.id,
        }),
      ).toEqual({ revision: 0, values: {} });
      expect(await snapshot((await admit(f)).runId)).toEqual({
        revision: 1,
        values: { RATE: 20 },
      });
      await admin.query(
        "update app.workflow_runs set status='succeeded',input_ref=null,input_ref_expires_at=null,created_at=clock_timestamp()-interval '32 days',completed_at=clock_timestamp()-interval '31 days' where id=$1",
        [source.runId],
      );
      await expect(
        runs.replay({
          ...command,
          idempotencyKeyHash: hash(),
          requestHash: hash(),
        }),
      ).rejects.toBeInstanceOf(RunVariableSnapshotUnavailableError);
    } finally {
      await runs.close();
    }
  });

  it('shares one maximum-size value set across fifty accepted runs', async () => {
    const f = await fixture();
    const values: Record<string, string> = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `TEXT_${String(index)}`,
        Array.from({ length: 4000 }, (_, offset) =>
          String.fromCharCode(97 + ((offset + index) % 26)),
        ).join(''),
      ]),
    );
    let spare = 32768 - Buffer.byteLength(canonicalJson(values));
    for (const key of Object.keys(values)) {
      const add = Math.min(96, spare);
      values[key] = (values[key] ?? '') + 'x'.repeat(add);
      spare -= add;
    }
    expect(Buffer.byteLength(canonicalJson(values))).toBe(32768);
    workspaceVariableValuesSchema.parse(values);
    await store.replace({
      ...scope(f.workspaceId),
      idempotencyKey: randomUUID(),
      expectedRevision: 0,
      values,
    });
    const started = performance.now();
    const accepted = [];
    for (let i = 0; i < 50; i += 1) accepted.push(await admit(f));
    expect(
      (
        await admin.query(
          'select count(*)::int n from app.workspace_variable_set_revisions where workspace_id=$1',
          [f.workspaceId],
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
    expect(
      (
        await admin.query(
          'select count(*)::int n,min(variable_set_revision)::int revision,sum(pg_column_size(variable_set_revision))::int reference_bytes from app.workflow_runs where id=any($1::uuid[])',
          [accepted.map((run) => run.runId)],
        )
      ).rows,
    ).toEqual([{ n: 50, revision: 1, reference_bytes: 200 }]);
    for (const run of accepted)
      expect(await snapshot(run.runId)).toEqual({ revision: 1, values });
    console.info(
      `Variable revision qualification: 32,768 canonical bytes, 50 runs, 200 reference bytes, ${String(Math.round(performance.now() - started))}ms.`,
    );
  });
}
