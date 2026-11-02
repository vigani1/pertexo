import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  actorId,
  createWebhookScenario,
  ownerQuery,
  workspaceId,
} from '../webhooks/fixture.js';
import {
  COMMANDS,
  EDITORS,
  editorReads,
  folders,
  member,
  NOT_EDITORS,
  READS,
  readNotFound,
  reopenWorkspace,
  scheduleReads,
  setWorkspaceStatus,
  useMemberFlows,
  writes,
  type Scenario,
} from './fixture.js';

useMemberFlows();

describe('reads on a trigger', () => {
  const editorCases = READS.flatMap(([name, read, expected]) =>
    EDITORS.map((role) => ({ name, read, expected, role })),
  );
  it.each(editorCases)(
    '$role reads $name',
    async ({ read, expected, role }) => {
      const scenario = await createWebhookScenario();
      expect(await read(scenario, member(role))).toEqual(expected(scenario));
    },
  );

  const outsiders = NOT_EDITORS.flatMap((role) => [
    ...editorReads.map(([name, read]) => ({ name, read, role, sees: false })),
    ...scheduleReads.map(([name, read, expected]) => ({
      name,
      read,
      expected,
      role,
      sees: true,
    })),
  ]);
  it.each(outsiders)('$role on $name: sees it is $sees', async (item) => {
    const scenario = await createWebhookScenario();
    const attempt = item.read(scenario, member(item.role));
    if (item.sees && 'expected' in item)
      expect(await attempt).toEqual(item.expected(scenario));
    else await expect(attempt).rejects.toBeInstanceOf(readNotFound(item.name));
  });
});

describe('a workspace that is not active', () => {
  it.each(READS.map(([name, read, expected]) => ({ name, read, expected })))(
    'still answers $name while suspended, and nothing once deletion is pending',
    async ({ name, read, expected }) => {
      const scenario = await createWebhookScenario();
      try {
        await setWorkspaceStatus('suspended');
        expect(await read(scenario, actorId)).toEqual(expected(scenario));
        await reopenWorkspace();
        await setWorkspaceStatus('pending_deletion');
        await expect(read(scenario, actorId)).rejects.toBeInstanceOf(
          readNotFound(name),
        );
      } finally {
        await reopenWorkspace();
      }
    },
  );

  it.each(COMMANDS)(
    'refuses to $name while suspended or pending deletion, and writes nothing',
    async ({ run, refused: error }) => {
      const scenario = await createWebhookScenario();
      const before = await writes(scenario);
      try {
        for (const status of ['suspended', 'pending_deletion'] as const) {
          await setWorkspaceStatus(status);
          await expect(run(scenario, actorId)).rejects.toBeInstanceOf(error);
          await reopenWorkspace();
          expect(await writes(scenario)).toEqual(before);
        }
      } finally {
        await reopenWorkspace();
      }
    },
  );
});

describe('a restricted folder', () => {
  async function inRestrictedFolder(scenario: Scenario) {
    const folder = (
      await folders.createFolder({
        workspaceId,
        actorId,
        name: `Private ${randomUUID()}`,
        parentId: null,
        idempotencyKey: randomUUID(),
      })
    ).folder.id;
    await folders.placeWorkflow({
      workspaceId,
      actorId,
      workflowId: scenario.verification.workflowId,
      folderId: folder,
      expectedOrganizationRevision: 1,
      idempotencyKey: randomUUID(),
    });
    await ownerQuery(
      "update app.workflow_folders set access_mode='restricted' where workspace_id=$1 and id=$2",
      [workspaceId, folder],
    );
    return folder;
  }

  it('hides everything from a builder without a grant', async () => {
    const scenario = await createWebhookScenario();
    await inRestrictedFolder(scenario);
    const builder = member('builder');
    const before = await writes(scenario);
    for (const { run, refused } of COMMANDS)
      await expect(run(scenario, builder)).rejects.toBeInstanceOf(refused);
    for (const [name, read] of READS)
      await expect(read(scenario, builder)).rejects.toBeInstanceOf(
        readNotFound(name),
      );
    expect(await writes(scenario)).toEqual(before);
  });

  it('lets a builder with a viewer grant read trigger health but not change a trigger', async () => {
    const scenario = await createWebhookScenario();
    const folder = await inRestrictedFolder(scenario);
    const builder = member('builder');
    await ownerQuery(
      "insert into app.workflow_folder_grants(id,workspace_id,folder_id,user_id,access) values($1,$2,$3,$4,'viewer')",
      [randomUUID(), workspaceId, folder, builder],
    );
    const before = await writes(scenario);
    for (const [, read, expected] of READS)
      expect(await read(scenario, builder)).toEqual(expected(scenario));
    for (const { run, refused } of COMMANDS)
      await expect(run(scenario, builder)).rejects.toBeInstanceOf(refused);
    expect(await writes(scenario)).toEqual(before);
  });
});
