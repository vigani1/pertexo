import { describe, expect, it } from 'vitest';
import {
  workflowGraphSchema,
  type WorkflowGraph,
} from '../../../src/graph/contract.js';
import {
  WORKFLOW_NOTE_LIMITS,
  type WorkflowNote,
} from '../../../src/graph/notes/contract.js';
import { sameWorkflowNotes } from '../../../src/graph/notes/identity.js';
import { stepSampleBindings } from '../../../src/authoring/samples/identity.js';
import {
  projectWorkflowPortableManifest,
  inspectWorkflowPortableManifest,
} from '../../../src/authoring/portability/projection.js';

const note: WorkflowNote = {
  id: '00000000-0000-4000-8000-000000000001',
  text: '# Orders\n\n**Keep** one per order.',
  position: { x: 20, y: -40 },
  size: { width: 320, height: 200 },
  color: 'teal',
};
const graph: WorkflowGraph = { nodes: [], edges: [], settings: {} };

describe('canvas note boundary', () => {
  it('retains documentation through graph and portable manifest round trips', () => {
    const original = { ...graph, notes: [note] };
    const parsed = workflowGraphSchema.parse(
      JSON.parse(JSON.stringify(original)),
    );
    expect(parsed).toEqual(original);
    const exported = projectWorkflowPortableManifest(parsed, {
      definitions: [],
    });
    const rebound = inspectWorkflowPortableManifest(exported, [], {
      definitions: [],
    });
    expect(rebound.graph.notes).toEqual([note]);
  });
  it('accepts the bounded maximum and refuses another note', () => {
    const notes = Array.from(
      { length: WORKFLOW_NOTE_LIMITS.count },
      (_, index) => ({
        ...note,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        text: 'x'.repeat(4000),
      }),
    );
    expect(workflowGraphSchema.safeParse({ ...graph, notes }).success).toBe(
      true,
    );
    expect(
      workflowGraphSchema.safeParse({
        ...graph,
        notes: [
          ...notes,
          { ...note, id: '11111111-1111-4111-8111-111111111111' },
        ],
      }).success,
    ).toBe(false);
  });
  it.each([
    { ...note, text: 'x'.repeat(4001) },
    { ...note, position: { x: Infinity, y: 0 } },
    { ...note, position: { x: 100001, y: 0 } },
    { ...note, size: { width: 199, height: 200 } },
    { ...note, size: { width: 320, height: 1201 } },
    { ...note, color: 'custom' },
    { ...note, id: 'not-a-note-id' },
  ])('refuses malformed or oversized note metadata', (invalid) => {
    expect(
      workflowGraphSchema.safeParse({ ...graph, notes: [invalid] }).success,
    ).toBe(false);
  });
  it('refuses duplicate note identities and the aggregate graph byte overflow', () => {
    expect(
      workflowGraphSchema.safeParse({ ...graph, notes: [note, note] }).success,
    ).toBe(false);
    expect(
      workflowGraphSchema.safeParse({
        ...graph,
        notes: [note],
        nodes: [
          {
            id: 'large',
            definition: { key: 'core.set', version: 1 },
            position: { x: 0, y: 0 },
            configVersion: 1,
            config: { value: 'x'.repeat(1048576) },
            inputMappings: {},
            connectionRefs: {},
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('keeps note metadata separate from pin identities and absent/empty documentation equivalent', () => {
    const step = {
      id: 'set',
      definition: { key: 'core.set', version: 1 },
      position: { x: 0, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {},
      connectionRefs: {},
    };
    const before = { ...graph, nodes: [step] };
    expect(stepSampleBindings({ ...before, notes: [note] })).toEqual(
      stepSampleBindings(before),
    );
    expect(sameWorkflowNotes(graph, { ...graph, notes: [] })).toBe(true);
    expect(
      sameWorkflowNotes(
        { ...graph, notes: [note] },
        { ...graph, notes: [{ ...note, text: 'Other documentation' }] },
      ),
    ).toBe(false);
  });
});
