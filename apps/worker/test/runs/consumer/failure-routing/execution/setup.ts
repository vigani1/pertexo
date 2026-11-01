import { randomUUID } from 'node:crypto';

import { createWorkflowRunDatabase } from '@pertexo/core/runs';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';

import { composeExecutableCatalog } from '@pertexo/workflow-engine';

import { coordinatorFixture as fixture } from '../../../../support/coordinator/consumer.js';
import { insertCompiledWorkflow } from '../../../../support/coordinator/workflows.js';
import { graph } from '../fixture.js';

export async function createRoutingBase() {
  const workflowId = randomUUID(),
    workflowVersionId = randomUUID();
  await insertCompiledWorkflow(fixture.ownerQuery, {
    actorId: fixture.actorId,
    workspaceId: fixture.workspaceId,
    identity: { workflowId, workflowVersionId },
    graph: graph(),
    name: 'Failure handling proof',
    catalog: PLATFORM_NODE_CATALOG,
  });
  await fixture.ownerQuery(
    'update app.workflows set published_version_id=$2 where id=$1',
    [workflowId, workflowVersionId],
  );
  const config = (url: string, max: number) =>
    parseDatabaseConfig({
      connectionString: fixture.databaseUrl(url),
      max,
    });
  const runs = createWorkflowRunDatabase(config(fixture.apiUrl, 4));
  const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
  const registry = createPlatformNodeRegistry();
  const coordinatorConfig = {
    maintenanceDatabase: config(fixture.dispatcherUrl, 2),
    database: config(fixture.workerUrl, 6),
    maximumAdmissions: 10,
    redisUrl: fixture.redisUrl,
  };
  const control: {
    mode: 'handled' | 'handler-failed' | 'handler-retry' | 'unknown' | 'normal';
    handlerRetried: boolean;
  } = { mode: 'handled', handlerRetried: false };

  let releaseHandler!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  const executed: { runId: string; nodeId: string; input: unknown }[] = [];
  const owners: (() => Promise<void>)[] = [() => runs.close()];

  return {
    workflowId,
    workflowVersionId,
    config,
    runs,
    catalog,
    registry,
    coordinatorConfig,
    control,
    releaseHandler,
    gate,
    executed,
    owners,
  };
}
