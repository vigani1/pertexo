import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { HttpBodyInputs } from '@/features/workflow-editor/components/inspector/http-body/inputs';
import { updateWorkflowNode } from '@/features/workflow-editor/model/graph/workflow-graph-commands';
import type { NodeFormApi } from '@/features/workflow-editor/model/inspector/node-form';
import {
  EditorStoreContext,
  useEditorStore,
} from '@/features/workflow-editor/model/state/context';
import { createEditorStore } from '@/features/workflow-editor/model/state/workflow-editor.store';

function setup() {
  const graph: WorkflowGraphContract = {
    nodes: [
      {
        id: 'http',
        label: 'Upload',
        definition: { key: 'http.request', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: { method: 'POST', url: 'https://api.example.test/upload' },
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [],
    settings: {},
  };
  const store = createEditorStore({ graph, etag: '"draft"', revision: 1 });
  const form: NodeFormApi = {
    nodeId: 'http',
    editable: true,
    reportScratch: vi.fn(),
    commit: (update, key) => {
      const current = store.getState();
      const step = current.graph.nodes[0];
      if (step === undefined) throw new Error('Step missing');
      current.transact(
        updateWorkflowNode(
          current.graph,
          step.id,
          typeof update === 'function' ? update(step) : update,
        ),
        { coalesceKey: key },
      );
    },
  };
  function Harness() {
    const node = useEditorStore((state) => state.graph.nodes[0]);
    const level = useEditorStore((state) => state.graph);
    if (node === undefined) return null;
    return (
      <HttpBodyInputs
        node={node}
        graph={level}
        form={form}
        fileScope={undefined}
        loopPorts={[]}
        links={null}
        rawInputs={() => null}
      />
    );
  }
  render(
    <EditorStoreContext value={store}>
      <Harness />
    </EditorStoreContext>,
  );
  const savedValues = () =>
    Object.values(store.getState().graph.nodes[0]?.inputMappings ?? {});
  return { savedValues };
}

const part = (number: number) =>
  screen.getByRole('group', { name: new RegExp(`^Part ${String(number)}:`) });

/**
 * A busy phone draws its next frame late. Holds the frames back until
 * `release`, so anything waiting for one runs after people have moved on.
 */
function holdFrames() {
  const held: FrameRequestCallback[] = [];
  const spy = vi
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((callback) => {
      held.push(callback);
      return held.length;
    });
  return {
    release: () => {
      spy.mockRestore();
      for (const callback of held.splice(0)) callback(performance.now());
    },
  };
}

it('focuses a new part at once and leaves the typing where people go next', async () => {
  const { savedValues } = setup();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Form parts' }));
  const frames = holdFrames();
  await user.click(screen.getByRole('button', { name: 'Add text part' }));
  const second = part(2);
  const name = within(second).getByLabelText('Field name');
  expect(name).toHaveFocus();
  const value = within(second).getByLabelText('Value');
  await user.click(value);
  frames.release();
  expect(value).toHaveFocus();
  await user.keyboard('second');
  expect(value).toHaveValue('second');
  expect(name).toHaveValue('field');
  expect(savedValues()).toContainEqual({ kind: 'literal', value: 'second' });
});

it('keeps focus on a moved part’s field name, and leaves it once people move on', async () => {
  setup();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Form parts' }));
  await user.click(screen.getByRole('button', { name: 'Add text part' }));
  await user.type(within(part(2)).getByLabelText('Value'), 'second');
  const frames = holdFrames();
  await user.click(
    within(part(2)).getByRole('button', { name: 'Move part up' }),
  );
  expect(within(part(1)).getByLabelText('Field name')).toHaveFocus();
  const value = within(part(1)).getByLabelText('Value');
  expect(value).toHaveValue('second');
  await user.click(within(part(2)).getByLabelText('Value'));
  frames.release();
  expect(within(part(2)).getByLabelText('Value')).toHaveFocus();
});

it('puts focus on the next part once a removal is confirmed, and leaves it once people move on', async () => {
  setup();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Form parts' }));
  await user.type(within(part(1)).getByLabelText('Value'), 'first');
  await user.click(screen.getByRole('button', { name: 'Add text part' }));
  await user.type(within(part(2)).getByLabelText('Value'), 'second');
  const frames = holdFrames();
  await user.click(
    within(part(1)).getByRole('button', { name: 'Remove part' }),
  );
  await user.click(await screen.findByRole('button', { name: 'Remove' }));
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  const name = within(part(1)).getByLabelText('Field name');
  expect(name).toHaveFocus();
  const value = within(part(1)).getByLabelText('Value');
  expect(value).toHaveValue('second');
  await user.click(value);
  frames.release();
  expect(value).toHaveFocus();
});
