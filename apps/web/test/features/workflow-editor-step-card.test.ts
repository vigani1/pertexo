import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { describe, expect, it } from 'vitest';
import {
  inlineOutputBytes,
  portLinkLabel,
  portLinks,
  shownPorts,
  stepSummary,
} from '@/features/workflow-editor/model/step-card';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

const cases = Array.from(
  { length: 16 },
  (_, index) => `case-${String(index + 1).padStart(2, '0')}`,
);
const branches = cases.map((port) => port.replace('case', 'branch'));

function definition(
  key: string,
  ports: NodeDefinitionCatalogItem['ports'],
  configSchema: NodeDefinitionCatalogItem['configSchema'] = {},
): NodeDefinitionCatalogItem {
  return {
    schemaVersion: 1,
    definition: { key, version: 1 },
    family: 'logic',
    configVersion: 1,
    configSchema,
    inputSchema: {},
    outputSchema: {},
    ports,
    credentialRequirements: [],
    connectionRequirements: [],
    retryClass: 'safe',
    resourceClass: 'cpu',
    capabilities: [],
    lifecycle: 'active',
    available: true,
    publishable: true,
  };
}

const portList = (
  key: string,
  ids: readonly string[],
  minItems: number,
): NodeDefinitionCatalogItem['configSchema'] => ({
  type: 'object',
  properties: {
    [key]: {
      type: 'array',
      minItems,
      items: { type: 'object', properties: { id: { enum: [...ids] } } },
    },
  },
});

const switchDefinition = definition(
  'core.switch',
  { inputs: ['in'], outputs: [...cases, 'default'] },
  portList('cases', cases, 1),
);
const parallelDefinition = definition(
  'core.parallel',
  { inputs: ['in'], outputs: branches },
  portList('branches', branches, 2),
);
const mergeDefinition = definition(
  'core.merge',
  { inputs: branches, outputs: ['out'] },
  { type: 'object', properties: { parallelNodeId: { type: 'string' } } },
);
const conditionDefinition = definition('core.condition', {
  inputs: ['in'],
  outputs: ['true', 'false'],
});

function step(
  id: string,
  key: string,
  extra: Partial<WorkflowNode> = {},
): WorkflowNode {
  return {
    id,
    label: id,
    definition: { key, version: 1 },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
    ...extra,
  };
}

function link(source: string, port: string, target: string, into = 'in') {
  return {
    id: `${source}-${port}-${target}`,
    source: { nodeId: source, port },
    target: { nodeId: target, port: into },
  };
}

describe('step cards', () => {
  it('draws only the cases a Switch sets up, its default and connected ones', () => {
    const router = step('router', 'core.switch', {
      config: { cases: [{ id: 'case-01' }, { id: 'case-02' }] },
    });
    const level = {
      nodes: [router, step('late', 'core.set')],
      edges: [link('router', 'case-05', 'late')],
    };
    expect(shownPorts(router, switchDefinition, level, 'outputs')).toEqual([
      'case-01',
      'case-02',
      'case-05',
      'default',
    ]);
    // A new Switch still has a case to wire, plus default.
    expect(
      shownPorts(
        step('new', 'core.switch'),
        switchDefinition,
        { nodes: [], edges: [] },
        'outputs',
      ),
    ).toEqual(['case-01', 'default']);
  });

  it('draws the branches a Parallel sets up, and a Merge those of its Parallel', () => {
    const fan = step('fan', 'core.parallel', {
      config: {
        branches: [{ id: 'branch-01' }, { id: 'branch-03' }],
        maxConcurrency: 2,
      },
    });
    const join = step('join', 'core.merge', {
      config: { parallelNodeId: 'fan', policy: { kind: 'all' } },
    });
    const level = { nodes: [fan, join], edges: [] };
    expect(shownPorts(fan, parallelDefinition, level, 'outputs')).toEqual([
      'branch-01',
      'branch-03',
    ]);
    expect(shownPorts(join, mergeDefinition, level, 'inputs')).toEqual([
      'branch-01',
      'branch-03',
    ]);
    expect(
      shownPorts(
        step('lonely', 'core.merge'),
        mergeDefinition,
        level,
        'inputs',
      ),
    ).toEqual(['branch-01', 'branch-02']);
    expect(
      shownPorts(
        step('check', 'core.condition'),
        conditionDefinition,
        level,
        'outputs',
      ),
    ).toEqual(['true', 'false']);
  });

  it('labels wired ports with where they lead', () => {
    const level = {
      nodes: [],
      edges: [
        link('check', 'true', 'finance'),
        link('check', 'true', 'audit'),
        link('check', 'false', 'erp'),
      ],
    };
    const titles = new Map([
      ['finance', 'Ask finance'],
      ['audit', 'Audit log'],
      ['erp', 'Post to ERP'],
    ]);
    const links = portLinks({ id: 'check' }, level, 'outputs', titles);
    expect(portLinkLabel('false', 'outputs', links.false)).toBe(
      'false → Post to ERP',
    );
    expect(portLinkLabel('true', 'outputs', links.true)).toBe(
      'true → Ask finance +1',
    );
    expect(portLinkLabel('default', 'outputs', links.default)).toBe('default');
    expect(
      portLinkLabel(
        'branch-02',
        'inputs',
        portLinks({ id: 'erp' }, level, 'inputs', titles).false,
      ),
    ).toBe('branch-02');
  });

  it('summarises a step’s own setup, and nothing it doesn’t hold', () => {
    expect(
      stepSummary(
        step('check', 'core.validate', {
          config: { rules: [{ id: 'a' }, { id: 'b' }] },
        }),
      ),
    ).toBe('2 rules');
    expect(
      stepSummary(step('erp', 'http.request', { config: { method: 'POST' } })),
    ).toBe('POST');
    expect(
      stepSummary(
        step('wait', 'core.wait', { config: { durationSeconds: 86_400 } }),
      ),
    ).toBe('1 day');
    expect(
      stepSummary(
        step('wait', 'core.wait', { config: { durationSeconds: 90 } }),
      ),
    ).toBe('1m 30s');
    expect(
      stepSummary(
        step('nightly', 'core.schedule', {
          config: { kind: 'interval', intervalMinutes: 15 },
        }),
      ),
    ).toMatch(/15 minutes/u);
    expect(stepSummary(step('check', 'core.validate'))).toBeUndefined();
    expect(stepSummary(step('slack', 'slack.send_message'))).toBeUndefined();
  });

  it('knows a passed test’s output size only when it came back inline', () => {
    // {"name":"Zoë"}: 14 characters, and ë takes two bytes.
    expect(inlineOutputBytes({ kind: 'inline', value: { name: 'Zoë' } })).toBe(
      15,
    );
    expect(
      inlineOutputBytes({
        kind: 'artifact',
        artifactId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toBeUndefined();
    expect(inlineOutputBytes(null)).toBeUndefined();
  });
});
