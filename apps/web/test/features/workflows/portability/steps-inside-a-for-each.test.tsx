import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { StepDescriptionsContext } from '@/features/catalog/hooks/step-descriptions';
import { WorkflowImportContents } from '@/features/workflows/components/portability/workflow-import-review';
import { portableSteps } from '@/features/workflows/model/portability';
import { describeBrowserStep } from '../../../support/fixtures/node-catalog';

const step = (id: string, key: string, label: string) => ({
  id,
  label,
  definition: { key, version: 1 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
  position: { x: 0, y: 0 },
});

const manifest = {
  graph: {
    nodes: [
      {
        ...step('loop', 'core.for_each', 'Each order'),
        structured: {
          kind: 'for_each',
          body: {
            nodes: [step('call', 'http.request', 'Call the shop')],
            edges: [],
          },
        },
      },
    ],
    edges: [],
    settings: {},
  },
} as unknown as Parameters<typeof WorkflowImportContents>[0]['manifest'];

it('counts the steps inside a For each', () => {
  expect(portableSteps(manifest).map(({ node }) => node.id)).toEqual([
    'loop',
    'call',
  ]);
});

it('shows a step inside a For each, and warns that it reaches outside', () => {
  render(
    <StepDescriptionsContext value={describeBrowserStep}>
      <WorkflowImportContents manifest={manifest} />
    </StepDescriptionsContext>,
  );
  const region = screen.getByRole('region', {
    name: 'What the file contains',
  });
  const items = within(region).getAllByRole('listitem');
  expect(items).toHaveLength(2);
  expect(items[1]).toHaveTextContent('Call the shop');
  expect(items[1]).toHaveTextContent('inside Each order');
  expect(items[1]?.querySelector('.text-warning')).not.toBeNull();
});
