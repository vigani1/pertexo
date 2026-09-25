import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { mappingDefinition, setDefinition } from './workflow-editor-fixtures';

// Contract-valid For each graphs (ADR 020) for the editor's body tests.

type WorkflowNode = WorkflowGraphContract['nodes'][number];
type WorkflowEdge = WorkflowGraphContract['edges'][number];

export const forEachDefinition = {
  ...setDefinition,
  definition: { key: 'core.foreach', version: 1 },
  family: 'logic',
  configSchema: { type: 'object', properties: {}, additionalProperties: false },
} satisfies NodeDefinitionCatalogItem;

/** A Set step whose inputs and outputs Insert data can offer. */
export const bodyStepDefinition = mappingDefinition;

export function step(
  id: string,
  label: string,
  position: WorkflowNode['position'] = { x: 0, y: 0 },
): WorkflowNode {
  return {
    id,
    label,
    definition: { key: 'core.set', version: 1 },
    position,
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
  };
}

export function link(id: string, source: string, target: string): WorkflowEdge {
  return {
    id,
    source: { nodeId: source, port: 'out' },
    target: { nodeId: target, port: 'in' },
  };
}

/** A For each around `nodes` and `edges`, with the exact ADR 020 ports. */
export function loopStep(
  id: string,
  label: string,
  body: Readonly<{ nodes: WorkflowNode[]; edges: WorkflowEdge[] }>,
  position: WorkflowNode['position'] = { x: 80, y: 80 },
): WorkflowNode {
  return {
    ...step(id, label, position),
    definition: { key: 'core.foreach', version: 1 },
    inputMappings: { items: { kind: 'run_input', path: '$.orders' } },
    structured: {
      kind: 'for_each',
      maxIterations: 100,
      maxConcurrency: 5,
      body: {
        schemaVersion: 1,
        ...body,
        settings: {},
        inputPorts: ['item', 'ordinal'],
        outputPorts: ['result'],
      },
    },
  };
}

/**
 * start → Each order (check → reserve) → after. The body's steps sit where
 * they were stored, both at the body's corner, as bodies built elsewhere
 * often are.
 */
export function orderLoopGraph(): WorkflowGraphContract {
  return {
    schemaVersion: 1,
    nodes: [
      step('start', 'Start', { x: -240, y: 80 }),
      loopStep('loop', 'Each order', {
        nodes: [step('check', 'Check stock'), step('reserve', 'Reserve item')],
        edges: [link('check-reserve', 'check', 'reserve')],
      }),
      step('after', 'After the loop', { x: 880, y: 80 }),
    ],
    edges: [
      link('start-loop', 'start', 'loop'),
      link('loop-after', 'loop', 'after'),
    ],
    settings: {},
  };
}
