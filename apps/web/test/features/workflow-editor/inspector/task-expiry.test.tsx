import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { approvalConfigSchema } from '@pertexo/workflow-model';
import { TaskExpiry } from '@/features/workflow-editor/components/inspector/human-task/expiry';
import type { NodeFormApi } from '@/features/workflow-editor/model/inspector/node-form';
import type {
  GraphLevel,
  WorkflowNode,
} from '@/features/workflow-editor/model/graph/scopes';

function Expiry({
  kind = 'core.approval',
  linked = false,
}: Readonly<{
  kind?: 'core.approval' | 'core.request_input';
  linked?: boolean;
}>) {
  const [node, setNode] = useState<WorkflowNode>({
    id: 'review',
    definition: { key: kind, version: 1 },
    configVersion: 1,
    position: { x: 0, y: 0 },
    config: linked ? { onExpiry: 'continue' } : {},
    inputMappings: {},
    connectionRefs: {},
  });
  const graph: GraphLevel = {
    nodes: [node],
    edges: linked
      ? [
          {
            id: 'late',
            source: { nodeId: 'review', port: 'timed_out' },
            target: { nodeId: 'escalate', port: 'in' },
          },
        ]
      : [],
  };
  const form: NodeFormApi = {
    nodeId: 'review',
    editable: true,
    reportScratch: vi.fn(),
    commit: (update) => {
      setNode((current) => ({
        ...current,
        ...(typeof update === 'function' ? update(current) : update),
      }));
    },
  };
  const setup = approvalConfigSchema.parse(node.config);
  return (
    <>
      <TaskExpiry
        node={node}
        graph={graph}
        form={form}
        kind={kind}
        seconds={setup.expiresAfterSeconds}
        onExpiry={setup.onExpiry}
      />
      <output aria-label="Saved configuration">
        {JSON.stringify(node.config)}
      </output>
    </>
  );
}

function saved() {
  return approvalConfigSchema.parse(
    JSON.parse(screen.getByLabelText('Saved configuration').textContent),
  );
}

describe('the expiry timeline and When nobody responds', () => {
  it('fails the step by default and says so on the timeline', () => {
    render(<Expiry />);
    expect(
      screen.getByText('Opens when the run reaches this step'),
    ).toBeVisible();
    expect(screen.getByText('7 days')).toBeVisible();
    expect(screen.getByText('then fails the step')).toBeVisible();
    expect(screen.getByRole('radio', { name: /Fail the step/u })).toBeChecked();
  });

  it('continues on Timed out once chosen and keeps the window it is given', async () => {
    render(<Expiry />);
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('radio', { name: /Continue on Timed out/u }),
    );
    expect(saved().onExpiry).toBe('continue');
    expect(screen.getByText('then continues on Timed out')).toBeVisible();
    const amount = screen.getByRole('textbox', { name: 'Expires after' });
    await user.clear(amount);
    await user.type(amount, '2');
    await user.tab();
    expect(saved().expiresAfterSeconds).toBe(2 * 86_400);
    expect(screen.getByText('2 days')).toBeVisible();
  });

  it('refuses a window shorter than an hour or longer than 30 days', async () => {
    render(<Expiry />);
    const user = userEvent.setup();
    const amount = screen.getByRole('textbox', { name: 'Expires after' });
    await user.clear(amount);
    await user.click(amount);
    await user.paste('31');
    await user.tab();
    expect(screen.getByText('Use 30 days or less.')).toBeVisible();
    await user.click(
      screen.getByRole('combobox', { name: 'Expires after unit' }),
    );
    await user.click(await screen.findByRole('option', { name: 'minutes' }));
    expect(screen.getByText('Use 1 hour or more.')).toBeVisible();
    expect(saved().expiresAfterSeconds).toBe(604_800);
  });

  it('keeps Timed out while it is linked', () => {
    render(<Expiry linked />);
    expect(
      screen.getByRole('radio', { name: /Fail the step/u }),
    ).toBeDisabled();
    expect(
      screen.getByText('Remove the Timed out link to fail the step instead.'),
    ).toBeVisible();
  });

  it('suggests a Request input carry on without an answer', () => {
    render(<Expiry kind="core.request_input" />);
    expect(screen.getByText(/carry on without an answer/u)).toBeInTheDocument();
  });
});
