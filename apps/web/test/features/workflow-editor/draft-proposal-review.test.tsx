import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { StepDescriptionsContext } from '@/features/catalog/hooks/step-descriptions';
import { DraftProposalReview } from '@/features/workflow-editor/components/draft-proposal-review';
import { catalogStepDescriptions } from '@/features/catalog/public';
import type { WorkflowValidationTarget } from '@/features/workflow-publish/public';
import { browserDefinitions } from '../../support/fixtures/node-catalog';
import { compatibility, graph, node } from '../workflow-publish/model/fixture';

it('shows the before and after values of changed settings and mappings', () => {
  const before = node('http', 'http.request', {
    label: 'Fetch orders',
    config: { url: 'https://api.example.test/orders', method: 'GET' },
    inputMappings: { region: { kind: 'literal', value: 'eu' } },
  });
  const base = {
    workflowId: '00000000-0000-4000-8000-000000000001',
    revision: 1,
    graph: graph([before]),
    compatibility,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  render(
    <DraftProposalReview
      graph={base.graph}
      onFix={() => undefined}
      result={{
        kind: 'inspected',
        base,
        draft: {
          ...base,
          graph: graph([
            {
              ...before,
              config: {
                ...before.config,
                url: 'https://api.example.test/v2/orders',
              },
              inputMappings: { region: { kind: 'literal', value: 'us' } },
            },
          ]),
        },
        representationTag: '"draft-1"',
        usage: {
          kind: 'complete',
          model: 'test',
          inputTokens: 1,
          outputTokens: 1,
        },
        validation: {
          valid: true,
          issues: [],
          compatibility,
          currentPublication: null,
        },
      }}
    />,
  );
  for (const value of [
    'url',
    'region',
    'https://api.example.test/orders',
    'https://api.example.test/v2/orders',
    'eu',
    'us',
  ])
    expect(screen.getByText(value, { exact: true })).toBeVisible();
  expect(screen.queryByText('method')).toBeNull();
});

it('shows the catalog field title and selects the step when asked to fix an issue', async () => {
  const definition = browserDefinitions().find(
    (item) => item.definition.key === 'http.request',
  );
  expect(definition).toBeDefined();
  if (definition === undefined) throw new Error('Missing HTTP step');
  const describe = catalogStepDescriptions([
    {
      ...definition,
      configSchema: {
        type: 'object',
        properties: {
          timeoutMillis: { type: 'number', title: 'Request deadline' },
        },
      },
    },
  ]);
  const current = graph([
    node('http', 'http.request', { label: 'Send order' }),
  ]);
  const draft = {
    workflowId: '00000000-0000-4000-8000-000000000001',
    revision: 1,
    graph: current,
    compatibility,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const selected: WorkflowValidationTarget[] = [];
  render(
    <StepDescriptionsContext value={describe}>
      <DraftProposalReview
        graph={current}
        onFix={(target) => {
          selected.push(target);
        }}
        result={{
          kind: 'inspected',
          base: draft,
          draft,
          representationTag: '"draft-1"',
          usage: {
            kind: 'complete',
            model: 'test',
            inputTokens: 1,
            outputTokens: 1,
          },
          validation: {
            valid: false,
            issues: [
              {
                code: 'invalid_graph',
                path: '$.nodes.http.config.timeoutMillis',
                message: 'timeoutMillis needs a value.',
              },
            ],
            compatibility,
            currentPublication: null,
          },
        }}
      />
    </StepDescriptionsContext>,
  );

  expect(screen.getByText('Send order', { exact: true })).toBeVisible();
  expect(screen.getByText('Request deadline needs a value.')).toBeVisible();
  expect(screen.queryByText(/timeoutMillis/iu)).toBeNull();
  await userEvent.click(
    screen.getByRole('button', { name: /Fix.*Request deadline/iu }),
  );
  expect(selected).toEqual([{ nodeId: 'http', fieldKey: 'timeoutMillis' }]);
});
