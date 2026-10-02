import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  OrganizationCommandFeedback,
  type OrganizationCommand,
} from '@/features/workflows/components/organization/organization-command-feedback';
import { workflowId, secondWorkflowId } from './workflow-list.fixtures';

function command(denied = false): OrganizationCommand {
  return {
    pending: false,
    retryAvailable: false,
    denied,
    error: undefined,
    result: {
      items: [
        {
          workflowId: secondWorkflowId,
          status: 'detached',
          organizationRevision: 10,
          replayed: true,
        },
        { workflowId, status: 'not_visible' },
      ],
    },
    start: vi.fn(() => Promise.resolve()),
    retry: vi.fn(() => Promise.resolve()),
    reset: vi.fn(),
  };
}
describe('organization command feedback names', () => {
  it('shows names in exact response order and never renders IDs', () => {
    render(
      <OrganizationCommandFeedback
        command={command()}
        names={
          new Map([
            [workflowId, 'Alpha'],
            [secondWorkflowId, 'Beta'],
          ])
        }
      />,
    );
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent(
      'Beta: Tag detached (previously completed)',
    );
    expect(items[1]).toHaveTextContent('Alpha: Not visible');
    expect(
      screen.queryByText(workflowId, { exact: false }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(secondWorkflowId, { exact: false }),
    ).not.toBeInTheDocument();
  });
  it.each([false, true])(
    'uses safe ordinal labels without authorized names (denied=%s)',
    (denied) => {
      render(
        <OrganizationCommandFeedback
          command={command(denied)}
          names={
            denied
              ? new Map([
                  [workflowId, 'Private Alpha'],
                  [secondWorkflowId, 'Private Beta'],
                ])
              : new Map()
          }
        />,
      );
      const items = within(screen.getByRole('list')).getAllByRole('listitem');
      expect(items[0]).toHaveTextContent('Workflow name unavailable (1)');
      expect(items[1]).toHaveTextContent('Workflow name unavailable (2)');
      expect(screen.queryByText(/Private/)).not.toBeInTheDocument();
      expect(
        screen.queryByText(workflowId, { exact: false }),
      ).not.toBeInTheDocument();
    },
  );
});
