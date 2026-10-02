import { describe, expect, it } from 'vitest';
import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/workflow-model/curated-templates';
import {
  curatedAutomaticScheduleVariation,
  curatedScheduleTimestamp,
  executeCuratedTemplateTriggers,
} from './curated-template-trigger-evidence.js';
import type { useBetterAuthRealApi } from './better-auth-real-api.integration.support.js';

describe('owned genuine curated trigger qualification', () => {
  it('makes an independent one-minute/two-item variation without changing the frozen reviewed asset', () => {
    const template = CURATED_WORKFLOW_TEMPLATES[1];
    if (template === undefined) throw new Error('Reviewed schedule missing');
    const graph = template.manifest.graph;
    const before = JSON.stringify(graph);
    const variation = curatedAutomaticScheduleVariation(graph);
    expect(
      variation.nodes.find((node) => node.id === 'schedule-start')?.config,
    ).toEqual({ kind: 'interval', intervalMinutes: 1, misfirePolicy: 'skip' });
    expect(
      variation.nodes.find((node) => node.id === 'batch-items')?.inputMappings
        .items,
    ).toEqual({ kind: 'literal', value: ['first', 'second'] });
    expect(variation.edges).toBe(graph.edges);
    expect(variation.nodes.find((node) => node.id === 'batch-complete')).toBe(
      graph.nodes.find((node) => node.id === 'batch-complete'),
    );
    expect(JSON.stringify(graph)).toBe(before);
    expect(
      graph.nodes.find((node) => node.id === 'schedule-start')?.config,
    ).toMatchObject({ intervalMinutes: 60 });
  });
  it('rejects missing or wrong-version schedule targets', () => {
    const graph = CURATED_WORKFLOW_TEMPLATES[1]?.manifest.graph;
    if (graph === undefined) throw new Error('Reviewed schedule missing');
    expect(() =>
      curatedAutomaticScheduleVariation({
        ...graph,
        nodes: graph.nodes.filter((node) => node.id !== 'schedule-start'),
      }),
    ).toThrow('Reviewed schedule graph required');
    expect(() =>
      curatedAutomaticScheduleVariation({
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.id === 'schedule-start'
            ? { ...node, definition: { ...node.definition, version: 1 } }
            : node,
        ),
      }),
    ).toThrow('Reviewed schedule graph required');
  });
  it('retains microsecond precision while comparing API and persisted due times', () => {
    expect(curatedScheduleTimestamp('2026-10-02T12:00:00.123Z')).toBe(
      '2026-10-02T12:00:00.123000Z',
    );
    expect(curatedScheduleTimestamp('2026-10-02T12:00:00.123456Z')).not.toBe(
      curatedScheduleTimestamp('2026-10-02T12:00:00.123457Z'),
    );
    expect(() =>
      curatedScheduleTimestamp('2026-10-02T12:00:00+01:00'),
    ).toThrow();
  });
  it.each([
    'https://127.0.0.1:1',
    'http://localhost:1',
    'http://example.test:1',
  ])(
    'fails closed before any API call outside exact owned loopback: %s',
    async (origin) => {
      const api = {} as ReturnType<typeof useBetterAuthRealApi>;
      await expect(
        executeCuratedTemplateTriggers(
          api,
          {} as Awaited<ReturnType<typeof api.signIn>>,
          'unused',
          [],
          origin,
        ),
      ).rejects.toThrow('Owned loopback API required');
    },
  );
});
