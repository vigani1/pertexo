import { describe, expect, it } from 'vitest';
import {
  LANE_COLUMN_WIDTH,
  LANE_ROW_HEIGHT,
  tidyLanePositions,
  workflowLanes,
} from '@/features/workflow-editor/model/graph/lanes';
import type { GraphLevel } from '@/features/workflow-editor/model/graph/scopes';

function step(id: string, x: number, y: number) {
  return {
    id,
    definition: { key: 'core.noop', version: 1 },
    position: { x, y },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
  };
}

function link(source: string, target: string, port = 'out') {
  return {
    id: `${source}-${port}-${target}`,
    source: { nodeId: source, port },
    target: { nodeId: target, port: 'in' },
  };
}

// New invoice → Check → Over 5,000? → (true) Approval → ERP; (false) ERP → Receipt,
// drawn a little crooked, with the approval above the rest.
const invoice: GraphLevel = {
  nodes: [
    step('intake', 0, 210),
    step('check', 280, 190),
    step('over', 640, 200),
    step('approve', 900, 30),
    step('erp', 1180, 220),
    step('receipt', 1500, 205),
  ],
  edges: [
    link('intake', 'check'),
    link('check', 'over'),
    link('over', 'approve', 'true'),
    link('over', 'erp', 'false'),
    link('approve', 'erp', 'approved'),
    link('erp', 'receipt'),
  ],
};

describe('workflow lanes', () => {
  it('opens a lane for the branch that leaves the row and keeps the rest in the main lane', () => {
    expect(workflowLanes(invoice)).toEqual([
      {
        rank: 0,
        opener: { nodeId: 'over', port: 'true' },
        nodeIds: ['approve'],
      },
      {
        rank: 1,
        opener: null,
        nodeIds: ['intake', 'check', 'over', 'erp', 'receipt'],
      },
    ]);
  });

  it('keeps a workflow without branches in one lane', () => {
    const straight: GraphLevel = {
      nodes: [step('a', 0, 0), step('b', 300, 40), step('c', 600, -20)],
      edges: [link('a', 'b'), link('b', 'c')],
    };
    expect(workflowLanes(straight)).toEqual([
      { rank: 0, opener: null, nodeIds: ['a', 'b', 'c'] },
    ]);
  });

  it('tidies steps into rows by lane and columns by the order they run', () => {
    const positions = tidyLanePositions(invoice);
    const origin = { x: 0, y: 30 };
    expect(Object.fromEntries(positions)).toEqual({
      approve: { x: origin.x + 3 * LANE_COLUMN_WIDTH, y: origin.y },
      intake: { x: origin.x, y: origin.y + LANE_ROW_HEIGHT },
      check: { x: origin.x + LANE_COLUMN_WIDTH, y: origin.y + LANE_ROW_HEIGHT },
      over: {
        x: origin.x + 2 * LANE_COLUMN_WIDTH,
        y: origin.y + LANE_ROW_HEIGHT,
      },
      // Waits for the approval, so it runs a column after it.
      erp: {
        x: origin.x + 4 * LANE_COLUMN_WIDTH,
        y: origin.y + LANE_ROW_HEIGHT,
      },
      receipt: {
        x: origin.x + 5 * LANE_COLUMN_WIDTH,
        y: origin.y + LANE_ROW_HEIGHT,
      },
    });
  });

  it('gives two unlinked starting steps a lane each', () => {
    const two: GraphLevel = {
      nodes: [step('top', 0, 0), step('bottom', 0, 400)],
      edges: [],
    };
    expect(Object.fromEntries(tidyLanePositions(two))).toEqual({
      top: { x: 0, y: 0 },
      bottom: { x: 0, y: LANE_ROW_HEIGHT },
    });
  });
});
