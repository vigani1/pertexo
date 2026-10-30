import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CODE_SETTINGS } from '@pertexo/node-sdk';
import { CodeSetup } from '@/features/workflow-editor/components/inspector/code/setup';
import type { NodeFormApi } from '@/features/workflow-editor/model/inspector/node-form';
import type { WorkflowNode } from '@/features/workflow-editor/model/graph/scopes';

function Setup({
  empty = false,
  editable = true,
}: {
  empty?: boolean;
  editable?: boolean;
}) {
  const [node, setNode] = useState<WorkflowNode>({
    id: 'code',
    definition: { key: 'core.code', version: 1 },
    configVersion: 1,
    position: { x: 0, y: 0 },
    config: { code: empty ? '' : 'return input;' },
    inputMappings: {},
    connectionRefs: {},
  });
  const form: NodeFormApi = {
    nodeId: node.id,
    editable,
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
      <CodeSetup
        config={node.config}
        form={form}
        settings={DEFAULT_CODE_SETTINGS}
      />
      <output aria-label="Saved configuration">
        {JSON.stringify(node.config)}
      </output>
    </>
  );
}

describe('Code language choice', () => {
  it('defaults old steps to JavaScript and preserves code unless the language change is confirmed', async () => {
    render(<Setup />);
    const user = userEvent.setup();
    expect(
      await screen.findByRole('textbox', { name: 'JavaScript' }),
    ).toHaveTextContent('return input;');
    await user.click(screen.getByRole('combobox', { name: 'Language' }));
    await user.click(await screen.findByRole('option', { name: 'Python' }));
    expect(
      screen.getByRole('dialog', { name: 'Switch to Python?' }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Saved configuration')).toHaveTextContent(
      '{"code":"return input;"}',
    );
    await user.click(screen.getByRole('combobox', { name: 'Language' }));
    await user.click(await screen.findByRole('option', { name: 'Python' }));
    await user.click(screen.getByRole('button', { name: 'Switch language' }));
    expect(
      await screen.findByRole('textbox', { name: 'Python' }),
    ).toHaveTextContent('return input;');
    expect(screen.getByLabelText('Saved configuration')).toHaveTextContent(
      '"language":"python"',
    );
    expect(screen.getByText(/Return JSON from input and _vars/u)).toBeVisible();
  });
  it('switches an empty source directly and keeps the role restriction', async () => {
    const user = userEvent.setup();
    const view = render(<Setup empty />);
    await user.click(screen.getByRole('combobox', { name: 'Language' }));
    await user.click(await screen.findByRole('option', { name: 'Python' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText('Saved configuration')).toHaveTextContent(
      '"language":"python"',
    );
    view.unmount();
    render(<Setup editable={false} />);
    expect(screen.getByRole('combobox', { name: 'Language' })).toBeDisabled();
  });
});
