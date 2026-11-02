import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PublishedStamp } from '@/features/workflow-publish/components/publication/published-stamp';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: Readonly<{ children: ReactNode }>) => (
    <a href="/triggers">{children}</a>
  ),
}));

function stamp(needsTriggerSetup: boolean) {
  render(
    <PublishedStamp
      versionNumber={1}
      reused
      liveAgain={false}
      hasTriggers
      needsTriggerSetup={needsTriggerSetup}
      canRun={false}
      onRunNow={vi.fn()}
      onDismiss={vi.fn()}
      scope={{ workspaceId: 'w', workflowId: 'f' }}
    />,
  );
}

describe('what publishing says', () => {
  it('names the one step left when nothing can start the workflow yet', () => {
    stamp(true);
    expect(screen.getByText('v1 is published')).toBeVisible();
    expect(
      screen.getByText('One step left: create the webhook address.'),
    ).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'Create the webhook address' }),
    ).toBeVisible();
    expect(screen.queryByText(/is still live/u)).toBeNull();
  });

  it('says it is live once triggers can start it', () => {
    stamp(false);
    expect(screen.getByText('v1 is still live')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open Triggers' })).toBeVisible();
  });
});
