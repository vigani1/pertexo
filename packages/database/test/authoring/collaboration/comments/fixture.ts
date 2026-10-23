import { randomUUID } from 'node:crypto';

import { createWorkflowAuthoringFixtureDatabase } from '../../../support/workflow-authoring-admission.fixture.js';
import {
  actorId,
  otherActorId,
  workspaceId,
  workflowId,
  apiUrl,
  parseDatabaseConfig,
  testDefinitionCatalog,
  queryAsOwner,
} from '../../../support/workflow-authoring.js';

export const database = createWorkflowAuthoringFixtureDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  {
    definitionCatalog: testDefinitionCatalog,
    portableCatalog: {
      definitions: [
        {
          key: 'test.placeholder',
          version: 1,
          configVersion: 1,
          slots: [],
          validateConfig: () => true,
        },
      ],
    },
  },
);

export function store() {
  if (database.collaboration === undefined)
    throw new Error('Discussion store missing');
  return database.collaboration;
}

export const scope = () => ({ workspaceId, workflowId, actorId });

export const command = () => ({ ...scope(), idempotencyKey: randomUUID() });

export async function beforeAllFixture1() {
  await queryAsOwner(
    `insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'viewer','active')`,
    [workspaceId, otherActorId],
    workspaceId,
  );
}

export async function afterAllFixture2() {
  return database.close();
}
