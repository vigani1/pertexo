import { expect, it } from 'vitest';
import {
  callbacks,
  config,
  running,
  queryAsOwner,
  workspaceId,
  hash,
  prepared,
} from './fixtures.js';

async function inventory(signal: AbortSignal) {
  const probes = [];
  for await (const probe of callbacks.keysInUse(signal)) probes.push(probe);
  return probes;
}

it('startup samples one live callback while ignoring a large retired history', async () => {
  const scope = await running();
  const [live] = await callbacks.prepare({
    ...scope,
    targets: [{ nodeId: 'wait', config }],
    keyVersion: '2',
    tokenHash: (identity) => hash(identity.id),
  });
  if (live === undefined) throw new Error('Callback missing');
  expect(await inventory(scope.signal)).toHaveLength(1);
  await queryAsOwner(
    `insert into app.pending_run_tasks(id,workspace_id,run_id,workflow_version_id,invocation_key,kind,config,status,callback_node_id,callback_scope,callback_scope_hash,callback_token_hash,callback_key_version,completed_at,consumed_at)
      select uuidv7(),source.workspace_id,source.run_id,source.workflow_version_id,'history:'||n,'callback',source.config,'canceled','history-'||n,'[]',source.callback_scope_hash,encode(sha256(n::text::bytea),'hex'),'retired',clock_timestamp(),clock_timestamp()
      from app.pending_run_tasks source cross join generate_series(1,10000) n where source.id=$1`,
    [live.id],
    workspaceId,
  );
  const signal = AbortSignal.timeout(5_000);
  const probes = await inventory(signal);
  expect(probes).toHaveLength(1);
  expect(probes[0]).toEqual({
    id: live.id,
    keyVersion: '2',
    tokenHash: live.tokenHash,
  });
});

it.each(['prepared', 'pending', 'submitted'] as const)(
  'keeps an unconsumed %s callback in startup verification',
  async (status) => {
    const { scope, callback } = await prepared();
    if (status === 'pending') {
      await queryAsOwner(
        "update app.pending_run_tasks set status='pending',node_run_id=$2,opened_at=clock_timestamp(),expires_at=clock_timestamp()+interval '1 hour' where id=$1",
        [callback.id, scope.nodeRunId],
        workspaceId,
      );
    } else if (status === 'submitted') {
      await queryAsOwner(
        `update app.pending_run_tasks set status='submitted',output_ref='{"kind":"inline","value":null}',completed_at=clock_timestamp() where id=$1`,
        [callback.id],
        workspaceId,
      );
    }
    expect(await inventory(scope.signal)).toEqual([
      { id: callback.id, keyVersion: '1', tokenHash: callback.tokenHash },
    ]);
    if (status === 'submitted') {
      await queryAsOwner(
        'update app.pending_run_tasks set consumed_at=clock_timestamp() where id=$1',
        [callback.id],
        workspaceId,
      );
      expect(await inventory(scope.signal)).toEqual([]);
    }
  },
);

it('samples once per version across inventory pages in code-unit order', async () => {
  const { scope, callback } = await prepared();
  await queryAsOwner(
    `insert into app.pending_run_tasks(id,workspace_id,run_id,workflow_version_id,invocation_key,kind,config,status,callback_node_id,callback_scope,callback_scope_hash,callback_token_hash,callback_key_version)
    select uuidv7(),source.workspace_id,source.run_id,source.workflow_version_id,'live:'||n,'callback',source.config,'prepared','live-'||n,'[]',source.callback_scope_hash,encode(sha256(n::text::bytea),'hex'),'v'||(n/2)::text
    from app.pending_run_tasks source cross join generate_series(0,519) n where source.id=$1`,
    [callback.id],
    workspaceId,
  );
  const probes = await inventory(scope.signal);
  expect(probes.map((probe) => probe.keyVersion)).toEqual(
    ['1', ...Array.from({ length: 260 }, (_, n) => `v${String(n)}`)].sort(),
  );
});

it.each(['expired', 'refused', 'canceled'] as const)(
  'ignores a finished %s callback even before consumption',
  async (status) => {
    const { scope, callback } = await prepared();
    await queryAsOwner(
      'update app.pending_run_tasks set status=$2,completed_at=clock_timestamp() where id=$1',
      [callback.id, status],
      workspaceId,
    );
    expect(await inventory(scope.signal)).toEqual([]);
  },
);
