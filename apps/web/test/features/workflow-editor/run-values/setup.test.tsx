import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { RunValuesSetup } from '@/features/workflow-editor/components/inspector/run-values/setup';
import type { WorkflowNode } from '@/features/workflow-editor/model/graph/scopes';
import type { NodeFormApi } from '@/features/workflow-editor/model/inspector/node-form';
const initial: WorkflowNode = {
  id: 'save',
  definition: { key: 'core.run_values', version: 1 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
  position: { x: 0, y: 0 },
};
function setup(node = initial) {
  const scratch = vi.fn();
  const committed = vi.fn<NodeFormApi['commit']>();
  function Harness() {
    const [current, setCurrent] = useState(node);
    const form: NodeFormApi = {
      nodeId: current.id,
      editable: true,
      reportScratch: scratch,
      commit: (update, key) => {
        committed(update, key);
        setCurrent((current) => ({
          ...current,
          ...(typeof update === 'function' ? update(current) : update),
        }));
      },
    };
    return (
      <>
        <RunValuesSetup
          node={current}
          graph={{ nodes: [current], edges: [] }}
          definitions={[]}
          form={form}
          variableScope={undefined}
        />
        <output aria-label="Saved mappings">
          {JSON.stringify(current.inputMappings)}
        </output>
      </>
    );
  }
  render(<Harness />);
  return { user: userEvent.setup(), committed, scratch };
}
it('edits plain key/value rows with normal mappings and keeps incomplete scratch out of the saved draft', async () => {
  const { user, committed, scratch } = setup();
  await user.click(screen.getByRole('button', { name: 'Add run value' }));
  expect(committed).not.toHaveBeenCalled();
  expect(scratch).toHaveBeenLastCalledWith('run-values', true);
  const row = screen.getByRole('region', { name: 'Run value' });
  await user.type(within(row).getByLabelText('Key'), 'orderId');
  await user.type(within(row).getByLabelText('Value'), 'A-1042');
  expect(
    JSON.parse(screen.getByLabelText('Saved mappings').textContent ?? '{}'),
  ).toEqual({ values: { kind: 'literal', value: { orderId: 'A-1042' } } });
  await user.click(within(row).getByRole('button', { name: 'Run input' }));
  await user.clear(within(row).getByLabelText('Run input path'));
  await user.type(within(row).getByLabelText('Run input path'), '$.orderId');
  expect(screen.getByLabelText('Saved mappings').textContent).toContain(
    'runInput',
  );
  expect(screen.getByText(/Use business data, never secrets/)).toBeVisible();
});
it('keeps whole-object mappings intact and offers the advanced Inputs editor', () => {
  const { committed } = setup({
    ...initial,
    inputMappings: { values: { kind: 'run_input', path: '$.business' } },
  });
  expect(screen.getByText(/Edit its mapping in Inputs/)).toBeVisible();
  expect(committed).not.toHaveBeenCalled();
});
