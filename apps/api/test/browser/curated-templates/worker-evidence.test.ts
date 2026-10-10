import { describe, expect, it } from 'vitest';
import {
  curatedTemplateEffectsSchema,
  curatedWebhookInputCases,
  curatedRunDiagnostic,
  curatedScheduleInputCase,
} from './worker-evidence.js';
import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/templates';
import { resolveSingleNodePreviewInput } from '@pertexo/workflow-engine';
import {
  CORE_VALIDATE_CONFIG_SCHEMA,
  CORE_SCHEDULE_INPUT_SCHEMA,
  evaluateCoreValidate,
} from '@pertexo/nodes-core';

const observation = { kind: 'http', status: 200, bodyHash: 'a'.repeat(64) };
const evidence = {
  phase: 'curated-template-effects',
  observations: [observation],
  pendingHttpResponses: 1,
};

describe('owned curated worker IPC evidence', () => {
  it('feeds the reviewed schedule v3 trigger-source resolver a valid registered input envelope', async () => {
    const node = CURATED_WORKFLOW_TEMPLATES[1]?.manifest.graph.nodes.find(
      (item) => item.id === 'schedule-start',
    );
    if (node === undefined) throw new Error('Reviewed schedule node missing');
    expect(node.definition).toEqual({ key: 'core.schedule', version: 1 });
    const input = await resolveSingleNodePreviewInput({
      node,
      runInput: curatedScheduleInputCase,
      signal: new AbortController().signal,
    });
    expect(input).toEqual(curatedScheduleInputCase);
    expect(CORE_SCHEDULE_INPUT_SCHEMA.safeParse(input).success).toBe(true);
  });
  it('emits only bounded reviewed terminal metadata, not private input/config/error messages', () => {
    const diagnostic = curatedRunDiagnostic('failed', [
      {
        nodeId: 'batch-items',
        status: 'failed',
        safeErrorCode: 'node_input_invalid',
        input: 'private',
        config: 'private',
        errorSummary: 'private',
      },
      { nodeId: 'secret-node', status: 'failed', safeErrorCode: 'private' },
      {
        nodeId: 'batch-body-result',
        status: 'private',
        safeErrorCode: 'https://private.example/',
      },
    ]);
    expect(diagnostic).toEqual({
      status: 'failed',
      nodes: [
        {
          nodeId: 'batch-items',
          status: 'failed',
          safeErrorCode: 'node_input_invalid',
        },
        { nodeId: 'batch-body-result', status: 'unknown', safeErrorCode: null },
      ],
    });
    expect(JSON.stringify(diagnostic)).not.toContain('private');
  });
  it('feeds the reviewed mapping and registered Validate semantics the intended accepted/rejected input cases', async () => {
    const node = CURATED_WORKFLOW_TEMPLATES[0]?.manifest.graph.nodes.find(
      (item) => item.id === 'validate-request',
    );
    if (node === undefined) throw new Error('Reviewed validation node missing');
    const config = CORE_VALIDATE_CONFIG_SCHEMA.parse(node.config);
    for (const [kind, runInput] of Object.entries(curatedWebhookInputCases)) {
      const input = await resolveSingleNodePreviewInput({
        node,
        runInput,
        signal: new AbortController().signal,
      });
      expect(input).toEqual({ payload: runInput });
      expect(evaluateCoreValidate(config, input).valid, kind).toBe(
        kind === 'accepted',
      );
    }
  });
  it('accepts only bounded hash/count evidence', () => {
    expect(curatedTemplateEffectsSchema.parse(evidence)).toEqual(evidence);
  });
  it.each([
    { ...evidence, token: 'synthetic-only' },
    {
      ...evidence,
      observations: [{ ...observation, text: 'unreviewed payload' }],
    },
    { ...evidence, observations: [{ ...observation, status: 501 }] },
    { ...evidence, observations: [{ ...observation, kind: 'email' }] },
    { ...evidence, observations: [{ ...observation, bodyHash: 'invalid' }] },
    {
      ...evidence,
      observations: Array.from({ length: 33 }, () => observation),
    },
    { ...evidence, pendingHttpResponses: -1 },
    { ...evidence, pendingHttpResponses: 17 },
    { ...evidence, phase: 'controlled-http-effects' },
  ])('rejects unknown, unbounded or raw-value evidence', (value) => {
    expect(curatedTemplateEffectsSchema.safeParse(value).success).toBe(false);
  });
});
