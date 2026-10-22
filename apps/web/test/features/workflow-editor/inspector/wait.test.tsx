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
  // 60 seconds reads as the largest unit it fills: 1 minute.
  expect(screen.getByRole('textbox', { name: 'Wait for' })).toHaveValue('1');
  expect(
    screen.getByRole('combobox', { name: 'Wait for unit' }),
  ).toHaveTextContent('minutes');
  await user.click(screen.getByRole('combobox', { name: 'Wait until' }));
  await user.click(await screen.findByRole('option', { name: 'Called back' }));
  expect(screen.getByRole('textbox', { name: 'Give up after' })).toHaveValue(
    '1',
  );
  expect(
    screen.getByRole('combobox', { name: 'Give up after unit' }),
  ).toHaveTextContent('hours');
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

it('saves an amount and unit as whole seconds, keeps the amount when the unit changes and stops at 30 days', async () => {
  render(<Wait />);
  const user = userEvent.setup();
  const duration = screen.getByRole('textbox', { name: 'Wait for' });
  await user.clear(duration);
  await user.type(duration, '10');
  await user.tab();
  expect(screen.getByLabelText('Saved configuration')).toHaveTextContent(
    '{"durationSeconds":600}',
  );
  await user.click(screen.getByRole('combobox', { name: 'Wait for unit' }));
  await user.click(await screen.findByRole('option', { name: 'days' }));
  // 10 days, still within 30.
  expect(screen.getByLabelText('Saved configuration')).toHaveTextContent(
    '{"durationSeconds":864000}',
  );
  await user.clear(duration);
  await user.type(duration, '31');
  await user.tab();
  expect(await screen.findByText('Use 30 days or less.')).toBeVisible();
  expect(duration).toHaveAttribute('aria-invalid', 'true');
  // Typing 31 passes through 3; the step keeps that last valid value.
  expect(screen.getByLabelText('Saved configuration')).toHaveTextContent(
    '{"durationSeconds":259200}',
  );
});
