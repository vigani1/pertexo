import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AboutTab } from '@/features/workflow-editor/components/inspector/about-tab';
import {
  manualDefinition,
  setDefinition,
} from '../support/workflow-editor-fixtures';
import { renderInRouter } from '../support/render-in-router';

function node(key: string) {
  return {
    id: 'step-1',
    definition: { key, version: 1 },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
  };
}

describe('the About tab', () => {
  it('lists the fields a step returns, with their types', async () => {
    renderInRouter(
      <AboutTab node={node('core.manual')} definition={manualDefinition} />,
    );
    const fields = await screen.findByRole('list', {
      name: 'Fields it returns',
    });
    expect(within(fields).getByText(/customer/u)).toHaveTextContent(
      'customer · string',
    );
  });

  it('says so when a step has no fixed fields', async () => {
    renderInRouter(
      <AboutTab node={node('core.set')} definition={setDefinition} />,
    );
    expect(
      await screen.findByText(
        'No fixed fields. The Test tab shows a real result.',
      ),
    ).toBeVisible();
  });
});
