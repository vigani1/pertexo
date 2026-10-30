import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { readWorkspaceUsageCapacity } from '../../../../src/runs/queries/usage-capacity.queries.js';
import { WorkspaceRunAdmissionDeniedError } from '../../../../src/runs/commands/acceptance/errors.js';
import { apiUrl, workspaceA } from '../../../runs/acceptance/fixtures.js';
import {
  acceptRun,
  withConcurrencyControls,
  withOwner,
} from '../concurrency-admission.fixtures.js';

// The usage page, the concurrency settings and admission must agree on
// whether the current execution entitlement is in effect.
export function registerAgreesOnEntitlementEffect(): void {
  it.each([
    {
      state: 'suspended',
      status: 'suspended',
      effectiveAt: '-infinity',
      expiresAt: null,
    },
    {
      state: 'not_yet_effective',
      status: 'active',
      effectiveAt: 'infinity',
      expiresAt: null,
    },
    {
      state: 'expired',
      status: 'active',
      effectiveAt: '-infinity',
      expiresAt: '2000-01-01',
    },
  ] as const)(
    'reports a $state entitlement the same way everywhere and admits no run',
    async ({ state, status, effectiveAt, expiresAt }) => {
      const previous = await withOwner(async (client) => {
        const current = await client.query<{ version: number }>(
          'select current_version version from app.workspace_execution_entitlements where workspace_id=$1',
          [workspaceA],
        );
        await client.query(
          `with next as (
             insert into app.workspace_execution_entitlement_versions
               (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at,expires_at)
             select $1,max(version)+1,$2,5,100,$3::timestamptz,$4::timestamptz
               from app.workspace_execution_entitlement_versions where workspace_id=$1
             returning version
           ) update app.workspace_execution_entitlements
               set current_version=(select version from next) where workspace_id=$1`,
          [workspaceA, status, effectiveAt, expiresAt],
        );
        return current.rows[0]?.version;
      });
      try {
        await withConcurrencyControls(async (controls, scope) => {
          expect(await controls.readSettings(scope)).toMatchObject({
            workspaceActiveRunLimit: null,
            workspacePolicyState: state,
          });
        });
        const pool = new Pool({ connectionString: apiUrl, max: 1 });
        try {
          expect(
            (
              await readWorkspaceUsageCapacity(pool, {
                workspaceId: workspaceA,
              })
            ).execution.policy.state,
          ).toBe(state);
        } finally {
          await pool.end();
        }
        await expect(acceptRun()).rejects.toBeInstanceOf(
          WorkspaceRunAdmissionDeniedError,
        );
      } finally {
        await withOwner((client) =>
          client.query(
            'update app.workspace_execution_entitlements set current_version=$2 where workspace_id=$1',
            [workspaceA, previous],
          ),
        );
      }
    },
  );
}
