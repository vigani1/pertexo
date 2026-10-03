import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CallableResultStepPicker } from '@/features/workflow-editor/components/inspector/callable-result-step-picker';
import { graphWithMappingNodes } from '../../../../support/workflow-editor-fixtures';

describe('callable result step shortcut', () => {
  it('does not descend into a root loop’s body when building choices', async () => {
    const [manual, target] = graphWithMappingNodes().nodes;
    if (manual === undefined || target === undefined)
      throw new Error('missing fixture steps');
    const loop = {
      ...target,
      label: 'Root loop',
      definition: { key: 'core.for_each', version: 1 },
      structured: {
        kind: 'for_each' as const,
        maxIterations: 2,
        maxConcurrency: 1,
        body: {
          schemaVersion: 1,
          nodes: [{ ...manual, id: 'body-step', label: 'Body child' }],
          edges: [],
          settings: {},
          inputPorts: ['item', 'ordinal'],
          outputPorts: ['result'],
        },
      },
    };
    render(
      <CallableResultStepPicker
        nodes={[loop]}
        source={{ kind: 'literal', value: {} }}
        disabled={false}
        onPick={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    screen.getByLabelText('Result step shortcut').focus();
    await user.keyboard('{ArrowDown}');
    expect(
      await screen.findByRole('option', { name: 'Root loop' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('option', { name: 'Body child' }),
    ).not.toBeInTheDocument();
  });
  it('offers only the supplied root steps and does not choose a default', async () => {
    const pick = vi.fn();
    render(
      <CallableResultStepPicker
        nodes={graphWithMappingNodes().nodes}
        source={{ kind: 'literal', value: {} }}
        disabled={false}
        onPick={pick}
      />,
    );
    expect(pick).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Result step shortcut'));
    await user.click(await screen.findByRole('option', { name: 'Target' }));
    expect(pick).toHaveBeenCalledExactlyOnceWith('target');
  });
  it('preserves a stored outside-root source instead of silently choosing a root', () => {
    const pick = vi.fn();
    render(
      <CallableResultStepPicker
        nodes={graphWithMappingNodes().nodes}
        source={{ kind: 'node_output', nodeId: 'body-step', path: '$.result' }}
        disabled={false}
        onPick={pick}
      />,
    );
    expect(screen.getByLabelText('Result step shortcut')).toHaveTextContent(
      'Outside root graph: body-step',
    );
    expect(pick).not.toHaveBeenCalled();
  });
  it('cannot overwrite guarded text or a read-only declaration', () => {
    render(
      <CallableResultStepPicker
        nodes={graphWithMappingNodes().nodes}
        source={{ kind: 'literal', value: {} }}
        disabled
        onPick={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Result step shortcut')).toBeDisabled();
  });
  it('does not offer disabled root steps as new result selections', async () => {
    const root = graphWithMappingNodes().nodes.map((node) => ({
      ...node,
      disabled: node.id === 'target',
    }));
    render(
      <CallableResultStepPicker
        nodes={root}
        source={{ kind: 'literal', value: {} }}
        disabled={false}
        onPick={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    screen.getByLabelText('Result step shortcut').focus();
    await user.keyboard('{ArrowDown}');
    expect(
      await screen.findByRole('option', { name: 'Target' }),
    ).toHaveAttribute('aria-disabled', 'true');
  });
});
