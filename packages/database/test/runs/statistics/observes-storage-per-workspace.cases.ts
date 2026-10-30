import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  readArtifactCapacity,
  readExecutionStorageCapacity,
} from '../../../src/artifacts/capacity.queries.js';
import {
  addRuns,
  busyWorkspace,
  inWorkspace,
  intake,
  quietWorkspace,
  workspaceDatabase,
} from './fixture.js';

export function registerObservesStoragePerWorkspace(): void {
  it('observes artifact and execution storage by status and surface for one workspace', async () => {
    await inWorkspace('api', busyWorkspace, {
      text: `insert into app.artifacts(id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,status,expires_at)
      values($2::uuid,$1::uuid,'user-upload','workspaces/'||$1::uuid::text||'/artifacts/'||$2::uuid::text,'text/plain',123,repeat('a',64),'pending',now()+interval '1 hour')`,
      values: [busyWorkspace, randomUUID()],
    });
    await addRuns(busyWorkspace, intake, {
      status: 'queued',
      count: 1,
      age: '1 minute',
    });
    await inWorkspace('api', busyWorkspace, {
      text: `insert into app.run_events(workspace_id,workflow_run_id,sequence,type,payload)
      select workspace_id,id,1,'run.queued','{}'::jsonb from app.workflow_runs
      where workspace_id=$1`,
      values: [busyWorkspace],
    });
    const observe = (workspaceId: string) =>
      workspaceDatabase.withWorkspace(workspaceId, async (transaction) => ({
        artifacts: await readArtifactCapacity(transaction),
        execution: await readExecutionStorageCapacity(transaction),
      }));

    const busy = await observe(busyWorkspace);
    expect(busy.artifacts).toEqual([
      { bytes: 0, count: 0, status: 'available' },
      { bytes: 0, count: 0, status: 'deleted' },
      { bytes: 0, count: 0, status: 'deleting' },
      { bytes: 123, count: 1, status: 'pending' },
    ]);
    expect(busy.execution).toEqual([
      { bytes: expect.any(Number) as number, count: 1, surface: 'event' },
      { bytes: 0, count: 0, surface: 'checkpoint' },
    ]);
    expect(busy.execution[0]?.bytes).toBeGreaterThan(0);
    await expect(observe(quietWorkspace)).resolves.toEqual({
      artifacts: [
        { bytes: 0, count: 0, status: 'available' },
        { bytes: 0, count: 0, status: 'deleted' },
        { bytes: 0, count: 0, status: 'deleting' },
        { bytes: 0, count: 0, status: 'pending' },
      ],
      execution: [
        { bytes: 0, count: 0, surface: 'event' },
        { bytes: 0, count: 0, surface: 'checkpoint' },
      ],
    });
  });
}
