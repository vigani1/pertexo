import { describe, expect, it, vi } from 'vitest';
import {
  AUTHORING_VALIDATION_BUDGET,
  AuthoringValidationUnavailableError,
} from '../../../src/authoring/validation/contracts.js';

import { parseWorkflowGraphDraft } from '../../../src/graph/validation/preflight.js';
import { validateWorkflowGraph } from '../../../src/graph/validation/index.js';
import * as policy from '../../../src/values/expressions/policy.js';
import { validateAuthoringBatch } from '../../../src/authoring/validation/graph.js';
import {
  policies,
  graph,
  createOwner,
  required,
} from '../../support/authoring-owner.js';
describe('report and invocation-local policy cache', () => {
  it('keeps unrelated canonical-data failures structural rather than operational', () => {
    const candidate = parseWorkflowGraphDraft(graph());
    const report = validateAuthoringBatch(
      {
        ...candidate,
        nodes: [
          { ...required(candidate.nodes[0]), config: { invalid: Number.NaN } },
        ],
      },
      policies,
    );
    expect(report).toMatchObject({
      ok: false,
      issues: [{ code: 'invalid_graph' }],
    });
  });

  it('preserves historical structural collection and full identifiers', () => {
    const source = required(graph().nodes[0]);
    const field = (i: number) => `field${String(i)}${'k'.repeat(8_000)}`;
    const candidate = parseWorkflowGraphDraft({
      ...graph(),
      nodes: [
        {
          ...source,
          inputMappings: Object.fromEntries(
            Array.from({ length: 100 }, (_, i) => [
              field(i),
              { kind: 'node_output', nodeId: 'missing', path: '$' },
            ]),
          ),
        },
      ],
    });
    const historical = validateWorkflowGraph(candidate);
    expect(historical.ok).toBe(false);
    expect(historical.issues).toHaveLength(100);
    expect(historical.issues[0]).toEqual({
      code: 'invalid_mapping',
      path: `$.nodes.${source.id}.inputMappings.${field(0)}`,
      message: 'node output mappings must reference a direct local predecessor',
    });
    expect(Buffer.byteLength(JSON.stringify(historical))).toBeGreaterThan(
      AUTHORING_VALIDATION_BUDGET.reportBytes,
    );
  });

  it('stops structural issue amplification before a large report is accumulated', () => {
    const source = required(graph().nodes[0]);
    const candidate = parseWorkflowGraphDraft({
      ...graph(),
      nodes: [
        {
          ...source,
          inputMappings: Object.fromEntries(
            Array.from({ length: 100 }, (_, i) => [
              `field${String(i)}${'k'.repeat(8_000)}`,
              { kind: 'node_output', nodeId: 'missing', path: '$' },
            ]),
          ),
        },
      ],
    });
    const serialization = vi.spyOn(JSON, 'stringify');
    expect(() => validateAuthoringBatch(candidate, policies)).toThrow(
      AuthoringValidationUnavailableError,
    );
    const largeReportWasAccumulated = serialization.mock.calls.some((call) => {
      const input: unknown = call[0];
      return (
        input !== null &&
        typeof input === 'object' &&
        'issues' in input &&
        Array.isArray(input.issues) &&
        input.issues.length > 32
      );
    });
    expect(largeReportWasAccumulated).toBe(false);
  });

  it('returns sanitized operational exhaustion for structural amplification through a real worker', async () => {
    const owner = createOwner();
    const source = required(graph().nodes[0]);
    const candidate = {
      ...graph(),
      nodes: [
        {
          ...source,
          inputMappings: Object.fromEntries(
            Array.from({ length: 100 }, (_, i) => [
              `field${String(i)}${'k'.repeat(5_000)}`,
              { kind: 'node_output', nodeId: 'missing', path: '$' },
            ]),
          ),
        },
      ],
    };
    await expect(owner.validate(candidate, policies)).rejects.toMatchObject({
      reason: 'report_limit',
      message: 'Workflow validation is temporarily unavailable.',
    });
    expect(owner.diagnostics().active).toBe(0);
  });

  it('deduplicates within one invocation only and caps findings without claiming validity', () => {
    const spy = vi.spyOn(policy, 'inspectExpression');
    const input = graph('runInput.');
    required(input.nodes[0]).inputMappings = Object.fromEntries(
      Array.from({ length: 150 }, (_, i) => [
        'f' + String(i),
        {
          kind: 'expression',
          language: 'jsonata',
          expression: 'runInput.',
        },
      ]),
    ) as (typeof input.nodes)[0]['inputMappings'];
    const admitted = parseWorkflowGraphDraft(input);
    const report = validateAuthoringBatch(admitted, policies);
    expect(report.ok).toBe(false);
    expect(report.issues).toHaveLength(100);
    expect(spy).toHaveBeenCalledTimes(1);
    validateAuthoringBatch(admitted, policies);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('fails report byte overflow operationally instead of exposing source/AST or truncating paths', () => {
    const input = graph('runInput.');
    const step = required(input.nodes[0]);
    step.inputMappings = {
      ['r'.repeat(AUTHORING_VALIDATION_BUDGET.reportBytes)]:
        step.inputMappings.result,
    } as typeof step.inputMappings;
    const admitted = parseWorkflowGraphDraft(input);
    expect(() => validateAuthoringBatch(admitted, policies)).toThrow(
      AuthoringValidationUnavailableError,
    );
  });
});
