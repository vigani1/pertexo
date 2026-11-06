import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeWorkflowLifecycleApiFixture,
  createWorkflowLifecycleApiFixture,
  mutationHeaders,
  type WorkflowLifecycleApiFixture,
  workflowLifecycleIntegrationEnabled,
} from '../lifecycle.support.js';

const describeIntegration = workflowLifecycleIntegrationEnabled
  ? describe
  : describe.skip;

const step = (
  id: string,
  key: string,
  x: number,
  extra: Readonly<Record<string, unknown>> = {},
) => ({
  id,
  definition: { key, version: 1 },
  position: { x, y: 0 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
  ...extra,
});

/** Manual start, then the step under check; the only thing wrong is that step's setup. */
function afterManual(candidate: ReturnType<typeof step>) {
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [step('manual', 'core.manual', 0), candidate],
    edges: [
      {
        id: 'manual-candidate',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: candidate.id, port: 'in' },
      },
    ],
  };
}

const httpConfig = (url?: string) => ({
  method: 'GET',
  ...(url === undefined ? {} : { url }),
  headers: {},
  timeoutMillis: 5_000,
  maxRedirects: 0,
  maxResponseBytes: 4_096,
  inlineResponseBytes: 4_096,
});

describeIntegration('checking a draft before it is published', () => {
  let fixture: WorkflowLifecycleApiFixture;

  beforeAll(async () => {
    fixture = await createWorkflowLifecycleApiFixture();
  }, 120_000);

  afterAll(async () => {
    await closeWorkflowLifecycleApiFixture(fixture);
  });

  async function saveAndValidate(graph: unknown) {
    const { application, ids, workspaceId } = fixture;
    const owner = await fixture.login('owner');
    const base = `/v1/workspaces/${workspaceId}/workflows/${ids.unpublished}`;
    const current = await application.inject({
      method: 'GET',
      url: `${base}/draft`,
      headers: { cookie: owner.cookieHeader },
    });
    expect(current.statusCode, current.body).toBe(200);
    const saved = await application.inject({
      method: 'PUT',
      url: `${base}/draft`,
      headers: mutationHeaders(owner, {
        'if-match': String(current.headers.etag),
      }),
      payload: { graph },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const validate = () =>
      application.inject({
        method: 'POST',
        url: `${base}/validate`,
        headers: mutationHeaders(owner),
        payload: {},
      });
    let checked = await validate();
    // A busy machine's validator asks for a retry, which is what the page offers.
    for (let tries = 1; checked.statusCode === 503 && tries < 5; tries += 1) {
      await delay(1_000);
      checked = await validate();
    }
    expect(checked.statusCode, checked.body).toBe(200);
    return {
      report: checked.json<{
        valid: boolean;
        issues: Readonly<Record<string, unknown>>[];
      }>(),
      publish: () =>
        application.inject({
          method: 'POST',
          url: `${base}/publish`,
          headers: mutationHeaders(owner, {
            'if-match': String(saved.headers.etag),
          }),
          payload: {},
        }),
    };
  }

  it.each([
    {
      name: 'a Condition with no condition input',
      candidate: step('candidate', 'core.condition', 200),
    },
    {
      name: 'an HTTP request with no URL',
      candidate: step('candidate', 'http.request', 200, {
        config: httpConfig(),
      }),
    },
    {
      name: 'an HTTP request whose URL its own setup rules refuse',
      candidate: step('candidate', 'http.request', 200, {
        config: httpConfig('https://api.example.test/orders?api_key=visible'),
      }),
    },
    {
      name: 'a Format text with no text input',
      candidate: step('candidate', 'core.text', 200, {
        config: { operation: 'uppercase' },
      }),
    },
  ])(
    'flags $name, by step, and refuses to publish it',
    async ({ candidate }) => {
      const { report, publish } = await saveAndValidate(afterManual(candidate));
      expect(report.valid).toBe(false);
      expect(JSON.stringify(report.issues)).toContain('candidate');
      const published = await publish();
      expect(published.statusCode, published.body).not.toBe(200);
    },
    60_000,
  );

  it('flags a step inside a For each body the same way', async () => {
    const { report } = await saveAndValidate({
      settings: { maxRunDurationMs: 60_000 },
      nodes: [
        step('manual', 'core.manual', 0),
        step('loop', 'core.foreach', 200, {
          inputMappings: { items: { kind: 'literal', value: [1, 2] } },
          structured: {
            kind: 'for_each',
            maxIterations: 2,
            maxConcurrency: 1,
            body: {
              settings: {},
              nodes: [step('inner', 'core.condition', 0)],
              edges: [],
              inputPorts: ['item', 'ordinal'],
              outputPorts: ['result'],
            },
          },
        }),
      ],
      edges: [
        {
          id: 'manual-loop',
          source: { nodeId: 'manual', port: 'out' },
          target: { nodeId: 'loop', port: 'in' },
        },
      ],
    });
    expect(report.valid).toBe(false);
    expect(JSON.stringify(report.issues)).toContain('inner');
  }, 60_000);

  it.each([
    {
      name: 'a Condition with a mapped input',
      candidate: step('candidate', 'core.condition', 200, {
        inputMappings: { condition: { kind: 'run_input', path: '$.ok' } },
      }),
    },
    {
      name: 'an HTTP request with a URL',
      candidate: step('candidate', 'http.request', 200, {
        config: httpConfig('https://api.example.test/orders?page=1'),
      }),
    },
    {
      name: 'a Format text with a mapped input',
      candidate: step('candidate', 'core.text', 200, {
        config: { operation: 'uppercase' },
        inputMappings: { value: { kind: 'run_input', path: '$.name' } },
      }),
    },
    {
      name: 'a Set fields step with no input',
      candidate: step('candidate', 'core.set', 200),
    },
  ])(
    'finds no issue on $name',
    async ({ candidate }) => {
      const { report } = await saveAndValidate(afterManual(candidate));
      expect(report.issues).toEqual([]);
      expect(report.valid).toBe(true);
    },
    60_000,
  );
  it('identifies an oversized execution scope consistently in Check and Publish', async () => {
    const nodes = [
      step('manual', 'core.manual', 0),
      ...Array.from({ length: 7 }, (_, n) =>
        step(
          `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`,
          'core.condition',
          200,
          { inputMappings: { condition: { kind: 'literal', value: true } } },
        ),
      ),
      step('leaf', 'core.set', 400),
    ];
    const graph = {
      settings: {},
      nodes,
      edges: nodes.slice(1).map((node, n) => ({
        id: `edge-${String(n)}`,
        source: {
          nodeId: nodes[n]?.id ?? '',
          port: n === 0 ? 'out' : 'true',
        },
        target: { nodeId: node.id, port: 'in' },
      })),
    };
    const { report, publish } = await saveAndValidate(graph);
    expect(report.valid).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.code).toBe('graph_limit');
    expect(report.issues[0]?.path).toMatch(/^\$\.nodes\./u);
    expect(report.issues[0]?.message).toContain(
      '256-character execution identity limit',
    );
    const refused = await publish();
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json<{ errors: unknown }>().errors).toEqual(report.issues);
  }, 60_000);
});
