import { z } from 'zod';

import { workflowGraphSchema, type WorkflowGraph } from '../graph-contract.js';
import {
  WORKFLOW_GRAPH_LIMITS,
  WorkflowGraphContractError,
} from './validation-contract.js';

function ownDataValue(value: object, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor))
    throw new WorkflowGraphContractError(
      'invalid_json',
      path,
      'accessors are not valid graph input',
    );
  return descriptor.value;
}

function preflightJsonDocument(input: unknown): number {
  type Frame =
    | {
        readonly kind: 'value';
        readonly value: unknown;
        readonly path: string;
        readonly depth: number;
      }
    | { readonly kind: 'exit'; readonly value: object };
  const stack: Frame[] = [{ kind: 'value', value: input, path: '$', depth: 1 }];
  const ancestors = new Set<object>();
  let bytes = 0;
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) continue;
    if (frame.kind === 'exit') {
      ancestors.delete(frame.value);
      continue;
    }
    if (frame.depth > WORKFLOW_GRAPH_LIMITS.inputDepth)
      throw new WorkflowGraphContractError(
        'json_value_depth',
        frame.path,
        `graph input depth exceeds ${String(WORKFLOW_GRAPH_LIMITS.inputDepth)}`,
      );
    const value = frame.value;
    if (value === null) {
      bytes += 4;
      continue;
    }
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
      continue;
    }
    if (typeof value === 'boolean') {
      bytes += value ? 4 : 5;
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      bytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
      continue;
    }
    if (typeof value !== 'object')
      throw new WorkflowGraphContractError(
        'invalid_json',
        frame.path,
        'value is not JSON',
      );
    if (ancestors.has(value))
      throw new WorkflowGraphContractError(
        'invalid_json',
        frame.path,
        'cyclic values are not JSON',
      );
    if (Object.getOwnPropertySymbols(value).length > 0)
      throw new WorkflowGraphContractError(
        'invalid_json',
        frame.path,
        'symbol properties are not JSON',
      );
    ancestors.add(value);
    stack.push({ kind: 'exit', value });
    if (Array.isArray(value)) {
      bytes += 2 + Math.max(0, value.length - 1);
      for (let index = value.length - 1; index >= 0; index -= 1) {
        if (!(index in value))
          throw new WorkflowGraphContractError(
            'invalid_json',
            `${frame.path}[${String(index)}]`,
            'sparse arrays are not JSON',
          );
        stack.push({
          kind: 'value',
          value: ownDataValue(
            value,
            String(index),
            `${frame.path}[${String(index)}]`,
          ),
          path: `${frame.path}[${String(index)}]`,
          depth: frame.depth + 1,
        });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null)
      throw new WorkflowGraphContractError(
        'invalid_json',
        frame.path,
        'object must be plain',
      );
    const keys = Object.keys(value);
    bytes += 2 + Math.max(0, keys.length - 1);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key === undefined) continue;
      bytes += Buffer.byteLength(JSON.stringify(key), 'utf8') + 1;
      stack.push({
        kind: 'value',
        value: ownDataValue(value, key, `${frame.path}.${key}`),
        path: `${frame.path}.${key}`,
        depth: frame.depth + 1,
      });
    }
  }
  return bytes;
}

function preflightJsonValue(value: unknown, path: string): void {
  const stack: {
    readonly value: unknown;
    readonly path: string;
    depth: number;
  }[] = [{ value, path, depth: 1 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (current.depth > WORKFLOW_GRAPH_LIMITS.jsonValueDepth)
      throw new WorkflowGraphContractError(
        'json_value_depth',
        current.path,
        `JSON value depth exceeds ${String(WORKFLOW_GRAPH_LIMITS.jsonValueDepth)}`,
      );
    if (
      current.value === null ||
      typeof current.value === 'string' ||
      typeof current.value === 'boolean' ||
      (typeof current.value === 'number' && Number.isFinite(current.value))
    )
      continue;
    if (typeof current.value !== 'object')
      throw new WorkflowGraphContractError(
        'invalid_json',
        current.path,
        'value is not JSON',
      );
    if (Object.getOwnPropertySymbols(current.value).length > 0)
      throw new WorkflowGraphContractError(
        'invalid_json',
        current.path,
        'symbol properties are not JSON',
      );
    if (Array.isArray(current.value)) {
      for (let index = 0; index < current.value.length; index += 1) {
        if (!(index in current.value))
          throw new WorkflowGraphContractError(
            'invalid_json',
            `${current.path}[${String(index)}]`,
            'sparse arrays are not JSON',
          );
        stack.push({
          value: ownDataValue(
            current.value,
            String(index),
            `${current.path}[${String(index)}]`,
          ),
          path: `${current.path}[${String(index)}]`,
          depth: current.depth + 1,
        });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(current.value) as object | null;
    if (prototype !== Object.prototype && prototype !== null)
      throw new WorkflowGraphContractError(
        'invalid_json',
        current.path,
        'object must be plain',
      );
    for (const key of Object.keys(current.value))
      stack.push({
        value: ownDataValue(current.value, key, `${current.path}.${key}`),
        path: `${current.path}.${key}`,
        depth: current.depth + 1,
      });
  }
}

function preflightWorkflowGraph(input: unknown): void {
  const graphs: {
    readonly value: unknown;
    readonly path: string;
    depth: number;
  }[] = [{ value: input, path: '$', depth: 0 }];
  while (graphs.length > 0) {
    const current = graphs.pop();
    if (current === undefined || current.value === null) continue;
    if (current.depth > WORKFLOW_GRAPH_LIMITS.structuredDepth)
      throw new WorkflowGraphContractError(
        'structured_depth',
        current.path,
        `structured graph depth exceeds ${String(WORKFLOW_GRAPH_LIMITS.structuredDepth)}`,
      );
    if (typeof current.value !== 'object' || Array.isArray(current.value))
      continue;
    const nodes = ownDataValue(current.value, 'nodes', `${current.path}.nodes`);
    if (!Array.isArray(nodes)) continue;
    for (let index = 0; index < nodes.length; index += 1) {
      const nodePath = `${current.path}.nodes[${String(index)}]`;
      const node = ownDataValue(nodes, String(index), nodePath);
      if (node === null || typeof node !== 'object' || Array.isArray(node))
        continue;
      const config = ownDataValue(node, 'config', `${nodePath}.config`);
      if (config !== undefined)
        preflightJsonValue(config, `${nodePath}.config`);
      const mappings = ownDataValue(
        node,
        'inputMappings',
        `${nodePath}.inputMappings`,
      );
      if (mappings !== null && typeof mappings === 'object') {
        for (const key of Object.keys(mappings)) {
          const mappingPath = `${nodePath}.inputMappings.${key}`;
          const mapping = ownDataValue(mappings, key, mappingPath);
          if (mapping !== null && typeof mapping === 'object') {
            const kind = ownDataValue(mapping, 'kind', `${mappingPath}.kind`);
            if (kind === 'literal')
              preflightJsonValue(
                ownDataValue(mapping, 'value', `${mappingPath}.value`),
                `${mappingPath}.value`,
              );
          }
        }
      }
      const structured = ownDataValue(
        node,
        'structured',
        `${nodePath}.structured`,
      );
      if (structured !== null && typeof structured === 'object')
        graphs.push({
          value: ownDataValue(
            structured,
            'body',
            `${nodePath}.structured.body`,
          ),
          path: `${nodePath}.structured.body`,
          depth: current.depth + 1,
        });
    }
  }
}

export function parseWorkflowGraphDraft(input: unknown): WorkflowGraph {
  const bytes = preflightJsonDocument(input);
  if (bytes > WORKFLOW_GRAPH_LIMITS.graphBytes)
    throw new WorkflowGraphContractError(
      'graph_limit',
      '$',
      'graph bytes exceed the graph limit',
    );
  preflightWorkflowGraph(input);
  return workflowGraphSchema.parse(input);
}

export type WorkflowGraphDraftParseResult =
  | { readonly success: true; readonly data: WorkflowGraph }
  | {
      readonly success: false;
      readonly error: WorkflowGraphContractError | z.ZodError;
    };

export function safeParseWorkflowGraphDraft(
  input: unknown,
): WorkflowGraphDraftParseResult {
  try {
    return { success: true, data: parseWorkflowGraphDraft(input) };
  } catch (error) {
    if (
      error instanceof WorkflowGraphContractError ||
      error instanceof z.ZodError
    )
      return { success: false, error };
    return {
      success: false,
      error: new WorkflowGraphContractError(
        'invalid_json',
        '$',
        error instanceof Error ? error.message : 'graph parsing failed',
      ),
    };
  }
}
