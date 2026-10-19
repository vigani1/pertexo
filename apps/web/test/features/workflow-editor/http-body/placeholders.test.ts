import { describe, expect, it } from 'vitest';
import {
  httpRequestPlaceholders,
  workflowPlaceholderIssues,
} from '@/features/workflow-editor/model/inspector/http-body';
import type { WorkflowNode } from '@/features/workflow-editor/model/graph/scopes';

const request = (
  id: string,
  inputMappings: WorkflowNode['inputMappings'] = {},
  extra: Partial<WorkflowNode> = {},
): WorkflowNode => ({
  id,
  definition: { key: 'http.request', version: 1 },
  configVersion: 1,
  config: {
    method: 'GET',
    url: 'https://api.example.test/orders/{orderId}?page={page}',
    headers: { 'x-customer': '{customer}' },
  },
  inputMappings,
  connectionRefs: {},
  position: { x: 0, y: 0 },
  ...extra,
});

describe('HTTP request placeholders in the editor', () => {
  it('lists the names the address and headers read', () => {
    expect(httpRequestPlaceholders(request('get'))).toEqual([
      'orderId',
      'page',
      'customer',
    ]);
  });

  it('asks for a value for each name no input maps, in loops too, not on disabled steps', () => {
    const issues = workflowPlaceholderIssues({
      nodes: [
        request('get', {
          orderId: { kind: 'run_input', path: '$.id' },
          page: { kind: 'literal', value: 1 },
        }),
        request('off', {}, { disabled: true }),
        {
          ...request('each'),
          definition: { key: 'core.foreach', version: 1 },
          structured: {
            kind: 'for_each',
            maxIterations: 10,
            maxConcurrency: 1,
            body: {
              nodes: [
                request('inner', {
                  orderId: { kind: 'literal', value: 1 },
                  page: { kind: 'literal', value: 1 },
                  customer: { kind: 'literal', value: 'c' },
                }),
              ],
              edges: [],
              settings: {},
              inputPorts: ['item', 'ordinal'],
              outputPorts: ['result'],
            },
          },
        },
      ],
      edges: [],
    });
    expect(issues).toEqual([
      {
        id: 'get:placeholder:customer',
        message:
          'Map a value for {customer}, used in the request address or headers.',
        target: { nodeId: 'get', mappingKey: 'customer' },
      },
    ]);
  });
});
