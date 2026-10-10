import { describe, expect, it } from 'vitest';

import {} from '../../src/platform/readiness.js';
import {
  acceptFixture,
  expectPgCode,
  scopedQuery,
  withOwnerRole,
  workspaceId,
} from './worker.fixture.js';

describe('preview worker schema contract', () => {
  it('withholds correlation and classification pins from runtime updates', async () => {
    const accepted = await acceptFixture();
    await expect(
      scopedQuery(
        `update app.preview_runs
            set request_id='forged-request',provider_key='forged'
          where workspace_id=$1 and id=$2`,
        [workspaceId, accepted.previewRunId],
      ),
    ).rejects.toSatisfy(expectPgCode('42501'));
  });

  it('rejects a one-sided preview provider identity by the exact constraint', async () => {
    const accepted = await acceptFixture();
    await expect(
      withOwnerRole(async (client) => {
        await client.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        await client.query(
          `insert into app.preview_runs
           select (jsonb_populate_record(
             null::app.preview_runs,
             to_jsonb(source)||jsonb_build_object(
               'id',gen_random_uuid(),
               'idempotency_key_hash',repeat('8',64),
               'request_hash',repeat('9',64),
               'provider_key','http',
               'operation_key',null
             )
           )).*
           from app.preview_runs source
           where source.workspace_id=$1 and source.id=$2`,
          [workspaceId, accepted.previewRunId],
        );
      }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'preview_runs_integration_identity_consistent',
    });
  });
});
