import { afterAll, describe, expect, it } from 'vitest';
import {
  InvalidWorkflowGraphError,
  WORKFLOW_GRAPH_LIMITS,
  type WorkflowCallPin,
  type WorkflowGraph,
  type WorkflowNode,
} from '@pertexo/workflow-model';
import {
  actorId,
  apiUrl,
  createHash,
  createWorkflowAuthoringDatabase,
  currentRepresentationTag,
  emptyGraph,
  otherWorkspaceId,
  otherActorId,
  parseDatabaseConfig,
  queryAsOwner,
  randomUUID,
  workspaceId,
} from '../../support/workflow-authoring.js';

const database = createWorkflowAuthoringDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  {
    definitionCatalog: {
      definitions: [
        'core.manual',
        'core.call',
        'core.foreach',
        'core.terminate',
      ].map((key) => ({ key, version: 1 })),
    },
  },
);
afterAll(() => database.close());
const node = (
  id: string,
  key: string,
  config: WorkflowNode['config'] = {},
): WorkflowNode => ({
  id,
  definition: { key, version: 1 },
  configVersion: 1,
  config,
  position: { x: 0, y: 0 },
  inputMappings: {},
  connectionRefs: {},
});
const graph = (pins: readonly WorkflowCallPin[] = []): WorkflowGraph => ({
  settings: {},
  edges: [],
  nodes: [
    node('manual', 'core.manual'),
    ...pins.map((pin, index) =>
      node(`call-${String(index)}`, 'core.call', { target: { ...pin } }),
    ),
    node('finish', 'core.terminate'),
  ],
  callable: {
    input: { type: 'string' },
    resultType: { type: 'string' },
    result: { kind: 'run_input', path: '$' },
  },
});
async function create(name: string, ws = workspaceId) {
  return (
    await database.createWorkflow({
      actorId: ws === otherWorkspaceId ? otherActorId : actorId,
      workspaceId: ws,
      name,
      emptyGraph,
      idempotencyKey: randomUUID(),
    })
  ).workflowId;
}
async function publish(id: string, value: WorkflowGraph, ws = workspaceId) {
  const author = ws === otherWorkspaceId ? otherActorId : actorId;
  const current = await database.getDraft(ws, id, author);
  if (current === null) throw new Error('Draft missing');
  await database.saveDraft({
    actorId: author,
    workspaceId: ws,
    workflowId: id,
    expectedRevision: current.revision,
    representationTag: await currentRepresentationTag(database, ws, {
      scopedWorkflowId: id,
      scopedActorId: author,
    }),
    graphJson: value,
  });
  const tag = await currentRepresentationTag(database, ws, {
    scopedWorkflowId: id,
    scopedActorId: author,
  });
  return database.publishWorkflow({
    actorId: author,
    workspaceId: ws,
    workflowId: id,
    representationTag: tag,
    idempotencyKey: randomUUID(),
    requestHash: createHash('sha256').update(tag).digest('hex'),
  });
}
const pin = (
  published: Awaited<ReturnType<typeof publish>>,
): WorkflowCallPin => ({
  workflowId: published.version.workflowId,
  workflowVersionId: published.version.id,
  executableChecksum: published.version.checksum,
});

describe('immutable Call publication dependencies', () => {
  it('retains exact pins across child publication and parent version reuse', async () => {
    const child = await create('Callable child');
    const first = await publish(child, graph());
    const parent = await create('Pinned parent');
    const parentGraph = graph([pin(first), pin(first)]);
    const accepted = await publish(parent, parentGraph);
    await publish(child, { ...graph(), settings: { maxRunDurationMs: 5_000 } });
    const reused = await publish(parent, parentGraph);
    expect(reused.version.id).toBe(accepted.version.id);
    expect(reused.reused).toBe(true);
    expect(
      await queryAsOwner(
        'select node_id,target_workflow_id,target_version_id from app.workflow_version_dependencies where parent_version_id=$1 order by node_id',
        [accepted.version.id],
        workspaceId,
      ),
    ).toEqual([
      {
        node_id: 'call-0',
        target_workflow_id: child,
        target_version_id: first.version.id,
      },
      {
        node_id: 'call-1',
        target_workflow_id: child,
        target_version_id: first.version.id,
      },
    ]);
  });

  it('lists current published parents once per workflow and pages without retaining superseded publications', async () => {
    const child = await create('Archive target');
    const target = pin(await publish(child, graph()));
    const first = await create('Archive parent one');
    const second = await create('Archive parent two');
    await publish(first, graph([target, target]));
    await publish(second, graph([target]));
    const input = { workspaceId, actorId, pinsWorkflowId: child, limit: 1 };
    const page = await database.listWorkflows(input);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    if (page.nextCursor === undefined)
      throw new Error('Expected pinned parent cursor');
    const next = await database.listWorkflows({
      ...input,
      after: page.nextCursor,
    });
    expect(next.items).toHaveLength(1);
    expect(
      new Set([...page.items, ...next.items].map((workflow) => workflow.id)),
    ).toEqual(new Set([first, second]));
    await publish(first, graph());
    const current = await database.listWorkflows({ ...input, limit: 100 });
    expect(current.items.map((workflow) => workflow.id)).toEqual([second]);
    expect(
      (
        await database.listWorkflows({
          ...input,
          workspaceId: otherWorkspaceId,
          actorId: otherActorId,
        })
      ).items,
    ).toEqual([]);
  });

  it('rejects rebound checksums, invisible pins and non-callable targets without publication effects', async () => {
    const child = await create('Pin checks');
    const callable = await publish(child, graph());
    const ordinaryGraph = graph();
    const { callable: _declaration, ...ordinary } = ordinaryGraph;
    const noncallable = await publish(child, ordinary);
    const parent = await create('Rejected pins');
    for (const target of [
      { ...pin(callable), executableChecksum: `wf:sha256:${'0'.repeat(64)}` },
      { ...pin(callable), workflowVersionId: randomUUID() },
      pin(noncallable),
    ])
      await expect(publish(parent, graph([target]))).rejects.toBeInstanceOf(
        InvalidWorkflowGraphError,
      );
    expect(
      await queryAsOwner(
        'select count(*)::int versions from app.workflow_versions where workflow_id=$1',
        [parent],
        workspaceId,
      ),
    ).toEqual([{ versions: 0 }]);
  });

  it('rejects an ancestor through an older version while permitting shared sibling dependencies', async () => {
    const a = await create('Ancestor A');
    const firstA = await publish(a, graph());
    const b = await create('Child B');
    const firstB = await publish(b, graph([pin(firstA)]));
    const c = await create('Child C');
    const firstC = await publish(c, graph([pin(firstA)]));
    const siblingParent = await create('Shared siblings');
    await expect(
      publish(siblingParent, graph([pin(firstB), pin(firstC)])),
    ).resolves.toHaveProperty('version.id');
    await expect(publish(a, graph([pin(firstB)]))).rejects.toMatchObject({
      issues: [{ code: 'invalid_graph' }],
    });
  });

  it('accepts weighted For Each products at the closure bound and refuses the next iteration', async () => {
    const child = await create('Weighted child');
    const target = await publish(child, graph());
    const parent = await create('Overflow parent');
    // Parent controls use three invocations; every item adds its Call and
    // the child's two steps, including its trigger.
    const iterations = Math.floor(
      (WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations - 3) / 3,
    );
    const repeated = (maxIterations: number): WorkflowGraph => ({
      ...graph(),
      nodes: [
        node('manual', 'core.manual'),
        {
          ...node('loop', 'core.foreach'),
          structured: {
            kind: 'for_each',
            maxIterations,
            maxConcurrency: 1,
            body: {
              settings: {},
              nodes: [
                node('body', 'core.call', { target: { ...pin(target) } }),
              ],
              edges: [],
              inputPorts: ['item', 'ordinal'],
              outputPorts: ['result'],
            },
          },
        },
        node('finish', 'core.terminate'),
      ],
    });
    await expect(publish(parent, repeated(iterations))).resolves.toHaveProperty(
      'version.id',
    );
    await expect(
      publish(parent, repeated(iterations + 1)),
    ).rejects.toMatchObject({
      issues: [{ code: 'expansion_limit' }],
    });
    expect(
      await queryAsOwner(
        'select count(*)::int versions from app.workflow_versions where workflow_id=$1',
        [parent],
        workspaceId,
      ),
    ).toEqual([{ versions: 1 }]);
  });

  it('cannot bind a target in another workspace', async () => {
    const child = await create('Other workspace child', otherWorkspaceId);
    const target = await publish(child, graph(), otherWorkspaceId);
    const parent = await create('Workspace fenced parent');
    await expect(publish(parent, graph([pin(target)]))).rejects.toBeInstanceOf(
      InvalidWorkflowGraphError,
    );
  });
});
