import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import { inspectPromotionRequirements } from '../../../src/authoring/promotion/preparation/inspect-requirements.js';
import { connectionScope } from '../../../src/shared/resources/connection-scope.repository.js';
import {
  beforeAllFixture1,
  afterAllFixture2,
  node,
  scope,
} from './bindings.fixture.js';
import { apiUrl, emptyGraph } from '../../support/workflow-authoring.js';

beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);

it('reports a missing table as an incompatible requirement at the promotion operation boundary', async () => {
  const pool = new Pool({ connectionString: apiUrl, max: 1 });
  try {
    const actor = scope();
    const requirements = await withTenantScopedClient(pool, actor, (client) =>
      inspectPromotionRequirements(client, actor.workspaceId, {
        workflowId: 'source-workflow',
        graph: {
          ...emptyGraph,
          nodes: [
            node('find', 'core.table_find', {
              table: 'Missing',
              columnBindings: {},
            }),
          ],
        },
        scope: connectionScope(actor, 'owner', 'connection:use'),
      }),
    );
    expect(requirements).toContainEqual({
      workflowId: 'source-workflow',
      kind: 'table',
      status: 'incompatible',
      name: 'Table columns',
      detail: 'find: Table Missing is unavailable. Select an existing table.',
    });
  } finally {
    await pool.end();
  }
});
