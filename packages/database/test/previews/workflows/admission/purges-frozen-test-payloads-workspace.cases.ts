import { expect, it } from 'vitest';

import {
  workspaceId,
  purgeTestWorkspace,
} from '../../../support/workflow-authoring.js';
import { query } from './fixture.js';

export function registerPurgesFrozenTestPayloadsWorkspace(): void {
  it('purges frozen test payloads with their workspace through maintenance', async () => {
    expect(
      (
        await query<{ count: string }>(
          'select count(*) from app.workflow_test_snapshots where workspace_id=$1',
          [workspaceId],
        )
      )[0]?.count,
    ).not.toBe('0');
    const steps = await purgeTestWorkspace(workspaceId, { pageSize: 2 });
    expect(steps).toContain('workflow_test_snapshots');
    expect(
      await query(
        'select id from app.workflow_test_snapshots where workspace_id=$1',
        [workspaceId],
      ),
    ).toEqual([]);
    expect(
      await query('select id from app.workflow_runs where workspace_id=$1', [
        workspaceId,
      ]),
    ).toEqual([]);
  });
}
