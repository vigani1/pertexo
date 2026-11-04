import { Pool } from 'pg';
import { afterAll } from 'vitest';
import { failUnadvanceableRun } from '../../../../src/runs/advance/fail-unadvanceable.repository.js';
import {
  asRuntime,
  databaseUrl,
  insertRun,
  notificationDestinationId,
  notificationSecretVersionId,
  testDelivery,
  workerBaseUrl,
  workspaceA,
} from '../run-store.fixture.js';

const pool = new Pool({ connectionString: databaseUrl(workerBaseUrl), max: 2 });
afterAll(() => pool.end());
export const safeErrorCode = 'execution.run_state_invalid';
export const query = <Row extends Record<string, unknown>>(
  text: string,
  values: unknown[],
) =>
  asRuntime(workerBaseUrl, workspaceA, (client) =>
    client.query<Row>(text, values),
  );

export async function emergencyRun(notify = true) {
  const runId = await insertRun({
    status: 'running',
    ...(notify
      ? {
          failureNotificationPolicy: {
            destinationId: notificationDestinationId,
            destinationConfigVersion: 1,
            sideEffectClass: 'idempotent_with_key',
            connectionSecretVersionId: notificationSecretVersionId,
          },
        }
      : {}),
  });
  const delivery = await testDelivery(workspaceA, runId, 0);
  return {
    runId,
    delivery,
    fail: (reportedDelivery = delivery) =>
      failUnadvanceableRun(pool, {
        workspaceId: workspaceA,
        runId,
        delivery: reportedDelivery,
        safeErrorCode,
        expectedRevision: 0,
        signal: new AbortController().signal,
      }),
  };
}
