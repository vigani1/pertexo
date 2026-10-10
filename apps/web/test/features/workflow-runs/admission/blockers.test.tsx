import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunAdmissionBlockers } from '@/features/workflow-runs/components/run-admission-blockers';
import { fixtureIds, fixtureRun } from '../../../support/fixtures/run';
import { workflowRunReadSummarySchema } from '@pertexo/contracts';

function run(
  status: Parameters<typeof fixtureRun>[1],
  overrides: Parameters<typeof fixtureRun>[2] = {},
) {
  return workflowRunReadSummarySchema.parse(
    fixtureRun(fixtureIds.firstRun, status, overrides),
  );
}

describe('current queued admission explanations', () => {
  it('renders only server-projected reasons with the exact observation time', () => {
    const asOf = '2026-10-01T10:00:00.123456Z';
    render(
      <RunAdmissionBlockers
        run={run('queued', {
          admissionBlockers: {
            asOf,
            reasons: [
              'workspace_capacity',
              'workflow_capacity',
              'workflow_order',
            ],
          },
        })}
      />,
    );
    expect(
      screen.getByText(
        /Waiting for workspace capacity, workflow concurrency capacity, an earlier accepted run to start/u,
      ),
    ).toBeVisible();
    expect(screen.getByTitle(asOf)).toHaveAttribute('datetime', asOf);
  });
  it('does not infer a blocker from queued status or show an old projection after starting', () => {
    const view = render(<RunAdmissionBlockers run={run('queued')} />);
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(
      <RunAdmissionBlockers
        run={run('running', {
          admissionBlockers: {
            asOf: '2026-10-01T10:00:00.000000Z',
            reasons: ['workflow_capacity'],
          },
        })}
      />,
    );
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(
      <RunAdmissionBlockers
        run={run('queued', {
          admissionBlockers: {
            asOf: '2026-10-01T10:00:00.000000Z',
            reasons: [],
          },
        })}
      />,
    );
    expect(view.container).toBeEmptyDOMElement();
  });
});
