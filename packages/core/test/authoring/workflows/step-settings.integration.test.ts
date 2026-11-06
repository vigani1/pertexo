import { randomUUID } from 'node:crypto';
import { InvalidWorkflowGraphError } from '@pertexo/workflow-model';
import { afterAll, expect, it } from 'vitest';
import {
  actorId,
  emptyGraph,
  workspaceId,
  currentRepresentationTag,
  saveCurrentDraft,
} from '../../support/workflow-authoring.js';
import { catalog, database } from './portability.fixture.js';

const step = (limit: number, extra: object = {}) => ({
  ...emptyGraph,
  nodes: [
    {
      id: 'n1',
      label: 'Fetch orders',
      definition: { key: 'test.placeholder', version: 1 },
      configVersion: 1,
      config: { limit },
      inputMappings: {},
      connectionRefs: {},
      position: { x: 0, y: 0 },
      ...extra,
    },
  ],
});

// A run refuses these settings, so publishing them would only fail later.
const accepting = database({
  portableCatalog: {
    definitions: [],
    acceptsStepConfig: (node) => (node.config.limit as number) <= 120_000,
  },
  definitionCatalog: catalog,
});

afterAll(() => accepting.close());

async function draftWith(limit: number, extra: object = {}) {
  const { workflowId } = await accepting.createWorkflow({
    actorId,
    workspaceId,
    emptyGraph,
    name: 'Settings a run would refuse',
    idempotencyKey: randomUUID(),
  });
  await saveCurrentDraft(accepting, {
    actorId,
    workspaceId,
    workflowId,
    expectedRevision: 1,
    graphJson: step(limit, extra),
  });
  return workflowId;
}

const publish = async (workflowId: string) =>
  accepting.publishWorkflow({
    actorId,
    workspaceId,
    workflowId,
    representationTag: await currentRepresentationTag(accepting, workspaceId, {
      scopedWorkflowId: workflowId,
      scopedActorId: actorId,
    }),
    idempotencyKey: randomUUID(),
    requestHash: 'a'.repeat(64),
  });

it('refuses to publish settings a run could only refuse, naming the step, and publishes nothing', async () => {
  const workflowId = await draftWith(300_000);
  const validated = await accepting.validateDraft(
    workspaceId,
    workflowId,
    actorId,
  );
  expect(validated?.validation).toMatchObject({
    ok: false,
    issues: [
      {
        code: 'invalid_step_settings',
        path: '$.nodes.n1.config',
        message: expect.stringContaining('Fetch orders') as string,
      },
    ],
  });
  await expect(publish(workflowId)).rejects.toBeInstanceOf(
    InvalidWorkflowGraphError,
  );
  const versions = await accepting.listVersions({
    workspaceId,
    workflowId,
    actorId,
  });
  expect(versions.items).toEqual([]);
});

it('publishes settings a run would accept', async () => {
  const workflowId = await draftWith(120_000);
  await expect(publish(workflowId)).resolves.toMatchObject({ reused: false });
});

it('leaves a disabled step alone, which never runs', async () => {
  const workflowId = await draftWith(300_000, { disabled: true });
  const validated = await accepting.validateDraft(
    workspaceId,
    workflowId,
    actorId,
  );
  expect(validated?.validation).toMatchObject({ ok: true, issues: [] });
  await expect(publish(workflowId)).resolves.toMatchObject({ reused: false });
});
