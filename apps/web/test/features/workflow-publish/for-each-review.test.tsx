import { render, screen, within } from '@testing-library/react';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { describe, expect, it } from 'vitest';
import { ReviewCandidate } from '@/features/workflow-publish/components/reviews/candidate';
import { diffWorkflowGraphs } from '@/features/workflows/comparison.public';

const step = (id: string, key: string, label: string, x = 0) => ({
  id,
  label,
  definition: { key, version: 1 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
  position: { x, y: 0 },
});

const graph = (
  body: readonly ReturnType<typeof step>[],
  maxItems = 10,
): WorkflowGraphContract =>
  ({
    nodes: [
      {
        ...step('loop', 'core.for_each', 'Each order'),
        structured: {
          kind: 'for_each',
          maxItems,
          body: { nodes: body, edges: [] },
        },
      },
    ],
    edges: [],
    settings: {},
  }) as unknown as WorkflowGraphContract;

const inside = step('one', 'http.request', 'Call the shop');

describe('reviewing what a For each will publish', () => {
  it('names a step added inside it, not the For each', () => {
    const diff = diffWorkflowGraphs(graph([]), graph([inside]));
    expect(diff.added.map(({ label }) => label)).toEqual(['Call the shop']);
    expect(diff.changed).toEqual([]);
  });

  it('counts moving a step inside it as no change', () => {
    const diff = diffWorkflowGraphs(
      graph([inside]),
      graph([{ ...inside, position: { x: 90, y: 0 } }]),
    );
    expect(diff.lines).toEqual([]);
    expect(diff.layoutOnly).toBe(true);
  });

  it('still says when the For each itself changed', () => {
    const diff = diffWorkflowGraphs(graph([inside]), graph([inside], 20));
    expect(diff.changed).toEqual([
      { id: 'loop', label: 'Each order', detail: 'setup' },
    ]);
  });

  it('lists the steps inside it under what will be published', () => {
    render(<ReviewCandidate graph={graph([inside])} liveGraph={null} />);
    const region = screen.getByRole('region', { name: 'Reviewed draft' });
    expect(screen.getByText(/2 steps added/u)).toBeVisible();
    expect(
      within(region).getByText(/http\.request · v1 · inside Each order/u),
    ).toBeVisible();
  });
});
