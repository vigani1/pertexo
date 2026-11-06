import { expect, it } from 'vitest';

import { withTenantScopedClient } from '@pertexo/database/primitives';
import { visibleArtifactIds } from '../../src/artifacts/references/access.repository.js';
import { fixture, ownerTransaction } from './lifetime.fixture.js';
import {
  workspaceId,
  userId,
  randomUUID,
} from '../lifecycle/retention.support.js';

it.each([
  'root',
  'node-file',
  'invocation',
  'join',
  'loop',
  'user-json',
] as const)(
  'uses the saved %s execution value consistently for artifact access and retention',
  async (location) => {
    const state = await fixture('literal', 'run-output');
    const runId = randomUUID();
    const versionId = randomUUID();
    const artifact = state.reference;
    const ordinary = {
      kind: 'inline',
      value: {
        nested: [{ kind: 'artifact', artifactId: state.reference.artifactId }],
      },
    };
    const { input, checkpoint } = {
      root: { input: artifact, checkpoint: {} },
      'node-file': {
        input: { kind: 'inline', value: { file: artifact } },
        checkpoint: {},
      },
      invocation: {
        input: ordinary,
        checkpoint: { invocations: [{ output: artifact }] },
      },
      join: {
        input: ordinary,
        checkpoint: { joins: [{ ledger: [{ output: artifact }] }] },
      },
      loop: {
        input: ordinary,
        checkpoint: { loops: [{ collection: artifact }] },
      },
      'user-json': { input: ordinary, checkpoint: {} },
    }[location];
    try {
      await ownerTransaction(async (client) => {
        await client.query(
          "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'owner','active') on conflict do nothing",
          [workspaceId, userId],
        );
      });
      await withTenantScopedClient(
        state.pool,
        { workspaceId },
        async (client) => {
          // Execution-produced artifacts require a readable owner; user uploads have
          // their own workspace-wide access rule and would hide a missing reference.
          await client.query(
            `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,completed_at,input_ref,input_ref_expires_at)
          values($1,$2,$3,$4,'manual','failed',clock_timestamp(),$5::jsonb,clock_timestamp()+interval '1 day')`,
            [
              runId,
              workspaceId,
              state.workflowId,
              versionId,
              JSON.stringify(input),
            ],
          );
          await client.query(
            `insert into app.run_checkpoints(workflow_run_id,workspace_id,workflow_version_id,revision,scheduler_state)
          values($1,$2,$3,1,$4::jsonb)`,
            [runId, workspaceId, versionId, JSON.stringify(checkpoint)],
          );
        },
      );
      const visible = await withTenantScopedClient(
        state.pool,
        { workspaceId },
        (client) =>
          visibleArtifactIds(client, { workspaceId, actorId: userId }, [
            state.reference.artifactId,
          ]),
      );
      expect([...visible]).toEqual(
        location === 'user-json' ? [] : [state.reference.artifactId],
      );
      await expect(state.coordinator.processNext()).resolves.toMatchObject({
        status: location === 'user-json' ? 'completed' : 'referenced',
        artifactId: state.reference.artifactId,
      });
      if (location !== 'user-json')
        expect(state.store.delete).not.toHaveBeenCalled();
    } finally {
      await state.close();
    }
  },
);
