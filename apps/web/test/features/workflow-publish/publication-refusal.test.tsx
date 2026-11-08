import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { useWorkflowPublication } from '@/features/workflow-publish/data/mutations/use-workflow-publication';
import { workflowIssuesView } from '@/features/workflow-publish/model/validation/issues-state';
import { IssuesList } from '@/features/workflow-publish/components/validation/issues-list';
import {
  client,
  json,
  report,
  saved,
  userId,
  workspaceId,
  workflowId,
  wrapper,
  requestPath,
} from './workflow-publication-snapshot/fixture';
const issues = [
  {
    path: 'nodes.target.inputMappings.rate',
    code: 'missing_variable',
    message: 'Workspace variable RATE does not exist.',
  },
  {
    path: 'nodes.target.config.audience',
    code: 'invalid_audience',
    message: 'Choose a current task audience.',
  },
] as const;
it('keeps every publication refusal and its field fixes until the attempted draft changes', async () => {
  const apiClient = client((input) =>
    Promise.resolve(
      requestPath(input).endsWith('/publish')
        ? json(
            {
              type: 'urn:pertexo:problem:workflow.invalid',
              title: 'Invalid workflow',
              status: 422,
              code: 'workflow.invalid',
              requestId: 'refused',
              errors: issues,
            },
            {},
            422,
          )
        : json(report, { etag: saved.etag }),
    ),
  );
  const event = userEvent.setup();
  render(<Screen />, { wrapper });
  await event.click(screen.getByRole('button', { name: 'Publish' }));
  await screen.findByText(issues[1].message);
  await event.click(
    screen.getByRole('button', { name: `Fix: ${issues[0].message}` }),
  );
  expect(screen.getByLabelText('Selected field')).toHaveTextContent(
    'target:rate',
  );
  await event.click(screen.getByRole('button', { name: 'Check again' }));
  expect(await screen.findByText(issues[1].message)).toBeVisible();
  expect(screen.getByLabelText('Report age')).toHaveTextContent('Current');
  await event.click(screen.getByRole('button', { name: 'Edit draft' }));
  expect(screen.getByLabelText('Report age')).toHaveTextContent(
    'Earlier draft',
  );
  function Screen() {
    const [generation, setGeneration] = useState(saved.generation);
    const [field, setField] = useState('');
    const publication = useWorkflowPublication({
      apiClient,
      userId,
      workspaceId,
      workflowId,
      verifyIdentity: () => Promise.resolve(),
      ensureSaved: () => Promise.resolve({ ...saved, generation }),
      isSavedDraftCurrent: (draft) => draft.generation === generation,
    });
    const graph = {
      settings: {},
      edges: [],
      nodes: [
        {
          id: 'target',
          definition: { key: 'core.set', version: 1 },
          configVersion: 1,
          position: { x: 0, y: 0 },
          config: {},
          inputMappings: {},
          connectionRefs: {},
        },
      ],
    };
    const view = workflowIssuesView(publication, graph, {
      generation,
      revision: saved.revision,
    });
    return (
      <>
        <button onClick={() => void publication.publish()}>Publish</button>
        <button onClick={() => void publication.validate()}>Check again</button>
        <button
          onClick={() => {
            setGeneration(generation + 1);
          }}
        >
          Edit draft
        </button>
        <p aria-label="Report age">
          {view.stale ? 'Earlier draft' : 'Current'}
        </p>
        <p aria-label="Selected field">{field}</p>
        <IssuesList
          graph={graph}
          groups={view.groups ?? []}
          onFix={(target) => {
            setField(
              `${target.nodeId}:${target.mappingKey ?? target.fieldKey ?? ''}`,
            );
          }}
        />
      </>
    );
  }
});
