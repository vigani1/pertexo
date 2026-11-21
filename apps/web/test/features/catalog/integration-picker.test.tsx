import { StepChoiceList } from '@/features/workflow-editor/components/add-step/picker';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { browserDefinitions } from '../../support/fixtures/node-catalog';

it('shows each integration with its established label and icon in the editor picker', () => {
  render(
    <StepChoiceList
      definitions={browserDefinitions()}
      query=""
      onPick={() => undefined}
    />,
  );

  for (const [name, icon] of [
    ['Database Row', 'webhook'],
    ['HTTP Polling', 'webhook'],
    ['Database', 'database'],
    ['Send email', 'mail'],
    ['HTTP request', 'globe'],
    ['Send Slack message', 'hash'],
  ] as const) {
    const button = screen.getByText(name, { exact: true }).closest('button');
    expect(button?.querySelector(`svg.lucide-${icon}`)).toBeInTheDocument();
  }
});
