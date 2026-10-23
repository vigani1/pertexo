import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';

import type {
  Query,
  CoordinatorWorkflowFixtureIdentities,
} from './contract.js';
import {
  linearGraph,
  branchGraph,
  parallelGraph,
  waitGraph,
} from './graphs/basic.js';
import { forEachGraph, nestedParallelGraph } from './graphs/loops.js';
import { insertCompiledWorkflow } from './write.js';

export async function seedCoordinatorWorkflowFixtures(
  query: Query,
  identities: CoordinatorWorkflowFixtureIdentities,
): Promise<void> {
  await query(
    `insert into app.users (id, email, display_name, status)
       values ($1, $2, 'Coordinator proof', 'active')`,
    [identities.actorId, `coordinator-${identities.actorId}@example.test`],
  );
  await query(
    `insert into app.workspaces (id, name, slug, status, created_by)
       values ($1, 'Coordinator proof', $2, 'active', $3)`,
    [
      identities.workspaceId,
      `coordinator-${identities.workspaceId}`,
      identities.actorId,
    ],
  );
  await query(
    `insert into app.workspace_memberships (workspace_id,user_id,role,status)
       values ($1,$2,'owner','active')`,
    [identities.workspaceId, identities.actorId],
  );
  await insertCompiledWorkflow(query, {
    actorId: identities.actorId,
    graph: linearGraph(),
    identity: identities.retained,
    name: 'Coordinator proof',
    catalog: PLATFORM_NODE_CATALOG,
    workspaceId: identities.workspaceId,
  });
  await Promise.all([
    insertCompiledWorkflow(query, {
      actorId: identities.actorId,
      graph: forEachGraph(),
      identity: identities.forEach,
      name: 'For Each recovery proof',
      catalog: PLATFORM_NODE_CATALOG,
      workspaceId: identities.workspaceId,
    }),
    insertCompiledWorkflow(query, {
      actorId: identities.actorId,
      graph: waitGraph(),
      identity: identities.wait,
      name: 'Wait control precedence proof',
      catalog: PLATFORM_NODE_CATALOG,
      workspaceId: identities.workspaceId,
    }),
    insertCompiledWorkflow(query, {
      actorId: identities.actorId,
      graph: nestedParallelGraph(),
      identity: identities.nestedParallel,
      name: 'Nested Parallel admission recovery proof',
      catalog: PLATFORM_NODE_CATALOG,
      workspaceId: identities.workspaceId,
    }),
    insertCompiledWorkflow(query, {
      actorId: identities.actorId,
      graph: parallelGraph(),
      identity: identities.parallel,
      name: 'Parallel Merge recovery proof',
      catalog: PLATFORM_NODE_CATALOG,
      workspaceId: identities.workspaceId,
    }),
    insertCompiledWorkflow(query, {
      actorId: identities.actorId,
      graph: branchGraph('switch'),
      identity: identities.switch,
      name: 'Switch recovery proof',
      catalog: PLATFORM_NODE_CATALOG,
      workspaceId: identities.workspaceId,
    }),
    insertCompiledWorkflow(query, {
      actorId: identities.actorId,
      graph: branchGraph('condition'),
      identity: identities.condition,
      name: 'Condition recovery proof',
      catalog: PLATFORM_NODE_CATALOG,
      workspaceId: identities.workspaceId,
    }),
  ]);
}
