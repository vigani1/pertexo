import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { WaitSetup } from '@/features/workflow-editor/components/inspector/wait/setup';
import type { NodeFormApi } from '@/features/workflow-editor/model/inspector/node-form';
import type { WorkflowNode } from '@/features/workflow-editor/model/graph/scopes';
import { callbackWaitConfigSchema } from '@pertexo/workflow-model';

function Wait() {
  const [node, setNode] = useState<WorkflowNode>({
    id: 'wait',
    definition: { key: 'core.wait', version: 1 },
    configVersion: 1,
    position: { x: 0, y: 0 },
    config: { durationSeconds: 60 },
    inputMappings: {},
    connectionRefs: {},
  });
  const form: NodeFormApi = {
    nodeId: 'wait',
    editable: true,
    reportScratch: vi.fn(),
    commit: (update) => {
      setNode((current) => ({
        ...current,
        ...(typeof update === 'function' ? update(current) : update),
      }));
    },
  };
  return (
    <>
      <WaitSetup config={node.config} form={form} />
      <output aria-label="Saved configuration">
        {JSON.stringify(node.config)}
      </output>
    </>
  );
}
it('switches Wait modes with normal live controls and keeps callback secrets out of the editor', async () => {
  render(<Wait />);
  const user = userEvent.setup();
  expect(
    screen.getByRole('textbox', { name: 'Wait for (in seconds)' }),
  ).toHaveValue('60');
  await user.click(screen.getByRole('combobox', { name: 'Wait until' }));
  await user.click(await screen.findByRole('option', { name: 'Called back' }));
  expect(
    screen.getByRole('textbox', { name: 'Callback timeout (seconds)' }),
  ).toHaveValue('3600');
  await user.click(
    screen.getByRole('combobox', { name: 'Callback authentication' }),
  );
  await user.click(
    await screen.findByRole('option', { name: 'Header secret' }),
  );
  const header = screen.getByRole('textbox', { name: 'Secret header name' });
  await user.clear(header);
  await user.type(header, 'x-callback-key');
  const config: unknown = JSON.parse(
    screen.getByLabelText('Saved configuration').textContent,
  );
  expect(callbackWaitConfigSchema.parse(config).authentication).toMatchObject({
    mode: 'header_secret',
    headerName: 'x-callback-key',
  });
  expect(screen.queryByLabelText('Authentication secret')).toBeNull();
  await user.click(screen.getByRole('combobox', { name: 'Wait until' }));
  await user.click(
    await screen.findByRole('option', { name: 'A duration has passed' }),
  );
  expect(screen.getByLabelText('Saved configuration')).toHaveTextContent(
    '{"durationSeconds":60}',
  );
});

it('keeps the existing duration control and its live saved value', async () => {
  render(<Wait />);
  const user = userEvent.setup();
  const duration = screen.getByRole('textbox', {
    name: 'Wait for (in seconds)',
  });
  await user.clear(duration);
  await user.type(duration, '600');
  await user.tab();
  expect(screen.getByLabelText('Saved configuration')).toHaveTextContent(
    '{"durationSeconds":600}',
  );
});
