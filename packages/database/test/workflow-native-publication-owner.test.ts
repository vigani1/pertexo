import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  validateWorkflowGraph,
  parseWorkflowGraphDraft,
  workflowRetainedExecutableChecksum,
  type WorkflowGraph,
} from '@pertexo/workflow-model/graph';
import { workflowCallableContractIdentityV1 } from '@pertexo/workflow-model/workflow-call-closure';
import { createWorkflowPublisher } from '../src/authoring/workflow-publication.js';
import {
  draftRepresentationTag,
  mapDraft,
} from '../src/authoring/workflow-authoring-rows.js';
import type { WorkflowExecutableCompiler } from '../src/authoring/workflow-authoring-types.js';

const id = (n: number) =>
  `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const catalog = { schemaVersion: 1, definitions: [] } as const;
const callable = {
  schemaVersion: 1 as const,
  input: { type: 'object' as const, properties: {}, required: [] },
  result: { type: 'object' as const, properties: {}, required: [] },
  resultSelector: { kind: 'literal' as const, value: {} },
};
const graph = {
  schemaVersion: 2,
  nodes: [],
  edges: [],
  settings: {},
  callable,
};
const retainedGraph = parseWorkflowGraphDraft({
  schemaVersion: 1,
  nodes: [],
  edges: [],
  settings: {},
});
const pin = {
  workflowId: id(4),
  versionId: id(5),
  checksum: `wf:v3:sha256:${'c'.repeat(64)}`,
  callableContractIdentity: workflowCallableContractIdentityV1(callable),
};
const callGraph = {
  ...graph,
  nodes: [
    {
      id: 'call',
      definition: { key: 'core.workflow_call', version: 1 },
      position: { x: 0, y: 0 },
      configVersion: 1,
      config: pin,
      inputMappings: {},
      connectionRefs: {},
    },
  ],
};
const publishedCallee = {
  id: pin.versionId,
  workspace_id: id(1),
  workflow_id: pin.workflowId,
  version_number: 1,
  schema_version: 2,
  graph_json: graph,
  checksum: pin.checksum,
  executable_schema_version: 3,
  published_by: id(3),
  published_at: new Date('2026-10-04T00:00:00Z'),
};

/** External query/transaction/compiler adapters only; no internal owner mocks.
 * Compiler semantics are separately exercised with the real V3 builder in API
 * admission-adapter.test.ts. These tests do not prove PostgreSQL authority.
 */
function fixture(
  source: WorkflowGraph & { readonly callable?: unknown },
  options: {
    compiler?: WorkflowExecutableCompiler;
    callee?: Record<string, unknown>;
    lookupFailure?: Error;
    afterCalleeRead?: () => void;
    signal?: AbortSignal;
  } = {},
) {
  const draftRow = {
    workflow_id: id(2),
    workspace_id: id(1),
    revision: 1,
    schema_version: 2,
    graph_json: source,
    updated_by: id(3),
    updated_at: new Date('2026-10-04T00:00:00Z'),
  };
  const statements: { sql: string; values: unknown[] | undefined }[] = [];
  const client = {
    query: (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (
        sql.includes('executable_schema_version') &&
        sql.includes('select id,workspace_id')
      ) {
        if (options.lookupFailure !== undefined)
          return Promise.reject(options.lookupFailure);
        return Promise.resolve({
          rows: options.callee === undefined ? [] : [options.callee],
          rowCount: options.callee === undefined ? 0 : 1,
        }).then((result) => {
          options.afterCalleeRead?.();
          return result;
        });
      }
      const rows = sql.includes('select request_hash,status,result_ref')
        ? [
            {
              request_hash: 'a'.repeat(64),
              status: 'in_progress',
              result_ref: {},
            },
          ]
        : sql.includes('select id from app.workflows')
          ? [{ id: id(2) }]
          : sql.includes('select * from app.workflow_drafts')
            ? [draftRow]
            : sql.includes('idle_in_transaction_session_timeout')
              ? [{ setting: '60000', unit: 'ms' }]
              : sql.includes('insert into app.workflow_versions')
                ? [
                    {
                      id: values?.[0],
                      workspace_id: values?.[1],
                      workflow_id: values?.[2],
                      version_number: 1,
                      schema_version: values?.[3],
                      graph_json: JSON.parse(values?.[4] as string) as unknown,
                      checksum: values?.[5],
                      published_by: id(3),
                      published_at: draftRow.updated_at,
                    },
                  ]
                : [];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  } as unknown as PoolClient;
  const publish = createWorkflowPublisher({
    durableResult: () => {
      throw new Error('unexpected replay');
    },
    keyDigest: () => 'b'.repeat(64),
    requireAuthor: () => Promise.resolve(),
    selectVariant: () =>
      Promise.resolve({
        compatibilityRelease: {
          epoch: 1,
          fingerprint: `node-compat:v1:sha256:${'d'.repeat(64)}`,
          catalogJson: '{}',
        },
        definitionCatalog: catalog,
        executableCompiler: options.compiler,
        validateAuthoringGraph: (value) =>
          Promise.resolve(validateWorkflowGraph(value)),
      }),
    testHooks: undefined,
    transact: (_workspace, _actor, operation) => operation(client),
  });
  return {
    statements,
    publish: () =>
      publish({
        workspaceId: id(1),
        workflowId: id(2),
        actorId: id(3),
        idempotencyKey: 'publish-native',
        requestHash: 'a'.repeat(64),
        representationTag: draftRepresentationTag(
          id(2),
          mapDraft(draftRow, catalog),
        ),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    versionWrites: () =>
      statements.filter(({ sql }) =>
        sql.includes('insert into app.workflow_versions'),
      ),
  };
}

describe('native publication through the existing publication owner', () => {
  it('rejects a nonexistent callable result selector before any version write', async () => {
    const owner = fixture({
      ...graph,
      callable: {
        ...callable,
        resultSelector: { kind: 'node_output', nodeId: 'absent', path: '$' },
      },
    });
    await expect(owner.publish()).rejects.toMatchObject({
      name: 'WorkflowCallClosureError',
      code: 'invalid_graph',
    });
    expect(owner.versionWrites()).toEqual([]);
  });

  it('keeps publication unavailable when no native compiler exists', async () => {
    const owner = fixture(graph);
    await expect(owner.publish()).rejects.toMatchObject({
      name: 'WorkflowDraftOperationUnavailableError',
    });
    expect(owner.versionWrites()).toEqual([]);
  });

  it('publishes the full native declaration rather than its validation projection', async () => {
    const compiledGraphs: WorkflowGraph[] = [];
    const owner = fixture(graph, {
      compiler: (value) => {
        compiledGraphs.push(value);
        return {
          checksum: `wf:v3:sha256:${'e'.repeat(64)}`,
          executableSchemaVersion: 3,
          executableJson: {
            compatibilityReleaseEpoch: 1,
            compatibilityReleaseFingerprint: `node-compat:v1:sha256:${'d'.repeat(64)}`,
          },
          compatibilityReleaseEpoch: 1,
          compatibilityReleaseFingerprint: `node-compat:v1:sha256:${'d'.repeat(64)}`,
        };
      },
    });
    await expect(owner.publish()).resolves.toMatchObject({
      replayed: false,
      reused: false,
      version: { schemaVersion: 2, graphJson: graph },
    });
    expect(compiledGraphs).toEqual([graph]);
    const values = owner.versionWrites()[0]?.values;
    expect(values?.[3]).toBe(2);
    expect(JSON.parse(values?.[4] as string)).toEqual(graph);
    expect(values?.[6]).toBe(3);
  });

  it.each([
    ['missing_version', undefined],
    [
      'pin_mismatch',
      { ...publishedCallee, checksum: `wf:v3:sha256:${'f'.repeat(64)}` },
    ],
    [
      'pin_mismatch',
      {
        ...publishedCallee,
        graph_json: {
          ...graph,
          callable: {
            ...callable,
            resultSelector: { kind: 'literal', value: { changed: true } },
          },
        },
      },
    ],
  ] as const)(
    'rejects %s using exact workspace/workflow/version lookup',
    async (code, callee) => {
      const owner = fixture(callGraph, callee === undefined ? {} : { callee });
      await expect(owner.publish()).rejects.toMatchObject({
        name: 'WorkflowCallClosureError',
        code,
      });
      const lookup = owner.statements.find(({ sql }) =>
        sql.includes('executable_schema_version'),
      );
      expect(lookup?.values).toEqual([id(1), pin.workflowId, pin.versionId]);
      expect(owner.versionWrites()).toEqual([]);
    },
  );

  it('does not reinterpret an operational version-read failure as a refusal', async () => {
    const failure = new Error('version read unavailable');
    const owner = fixture(callGraph, { lookupFailure: failure });
    await expect(owner.publish()).rejects.toBe(failure);
    expect(owner.versionWrites()).toEqual([]);
  });

  it.each(['before lookup', 'after lookup'] as const)(
    'preserves cancellation %s instead of compiling or inserting a version',
    async (when) => {
      const controller = new AbortController();
      const reason = new Error('publication request cancelled');
      const compiler = vi.fn<WorkflowExecutableCompiler>();
      if (when === 'before lookup') controller.abort(reason);
      const owner = fixture(callGraph, {
        callee: publishedCallee,
        compiler,
        signal: controller.signal,
        ...(when === 'after lookup'
          ? {
              afterCalleeRead: () => {
                controller.abort(reason);
              },
            }
          : {}),
      });
      await expect(owner.publish()).rejects.toBe(reason);
      expect(compiler).not.toHaveBeenCalled();
      expect(owner.versionWrites()).toEqual([]);
      const lookups = owner.statements.filter(({ sql }) =>
        sql.includes('executable_schema_version'),
      );
      expect(lookups).toHaveLength(when === 'before lookup' ? 0 : 1);
      if (when === 'after lookup')
        expect(lookups[0]?.values).toEqual([
          id(1),
          pin.workflowId,
          pin.versionId,
        ]);
    },
  );

  it.each([
    [
      'wrong workspace',
      'pin_mismatch',
      { ...publishedCallee, workspace_id: id(6) },
    ],
    [
      'wrong workflow',
      'pin_mismatch',
      { ...publishedCallee, workflow_id: id(6) },
    ],
    [
      'wrong immutable version',
      'pin_mismatch',
      { ...publishedCallee, id: id(6) },
    ],
    [
      'retained executable on native graph',
      'pin_mismatch',
      { ...publishedCallee, executable_schema_version: 2 },
    ],
    [
      'missing executable format',
      'pin_mismatch',
      { ...publishedCallee, executable_schema_version: null },
    ],
    [
      'retained graph with native executable',
      'pin_mismatch',
      {
        ...publishedCallee,
        schema_version: 1,
        checksum: workflowRetainedExecutableChecksum(retainedGraph),
        graph_json: retainedGraph,
      },
    ],
    [
      'no callable declaration',
      'not_callable',
      {
        ...publishedCallee,
        graph_json: { schemaVersion: 2, nodes: [], edges: [], settings: {} },
      },
    ],
  ] as const)(
    'rejects %s before compilation or version insertion',
    async (_description, code, callee) => {
      const compiler = vi.fn<WorkflowExecutableCompiler>();
      const owner = fixture(callGraph, { callee, compiler });
      await expect(owner.publish()).rejects.toMatchObject({
        name: 'WorkflowCallClosureError',
        code,
      });
      expect(compiler).not.toHaveBeenCalled();
      expect(owner.versionWrites()).toEqual([]);
      expect(
        owner.statements.find(({ sql }) =>
          sql.includes('executable_schema_version'),
        )?.values,
      ).toEqual([id(1), pin.workflowId, pin.versionId]);
    },
  );

  it('keeps a corrupted stored graph/checksum pairing operational rather than reporting an eligible target refusal', async () => {
    const compiler = vi.fn<WorkflowExecutableCompiler>();
    const owner = fixture(callGraph, {
      compiler,
      callee: {
        ...publishedCallee,
        schema_version: 1,
        graph_json: { schemaVersion: 1, nodes: [], edges: [], settings: {} },
      },
    });
    await expect(owner.publish()).rejects.toThrow(
      'Stored workflow version checksum format does not match its graph',
    );
    expect(compiler).not.toHaveBeenCalled();
    expect(owner.versionWrites()).toEqual([]);
  });
});
