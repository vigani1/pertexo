import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderApp } from '../../../support/render-app';
import { inboxApi, type thread, workspaceId } from './fixture';

const destinationId = '12121212-1212-4212-8212-121212121212';

describe('failure alert notice', () => {
  it('says plainly what is wrong and leads to the destination', async () => {
    const notice = {
      id: destinationId,
      noticeKind: 'failure_alert_attention',
      subjectId: destinationId,
      workflowId: null,
      name: 'Slack',
      details: {},
      limits: [],
      occurrenceCount: 1,
      firstOccurredAt: '2026-09-15T09:00:00.000000Z',
      latestOccurredAt: '2026-09-15T09:30:00.000000Z',
      revision: '7',
      unread: true,
    };
    inboxApi({
      threads: [notice as unknown as ReturnType<typeof thread>],
      revision: '7',
    });
    renderApp(`/w/${workspaceId}/inbox`);

    const title = await screen.findByRole('link', {
      name: /Failure alerts aren’t reaching Slack/u,
    });
    expect(title).toHaveAttribute(
      'href',
      `/w/${workspaceId}/settings/alerts?destination=${destinationId}`,
    );
    const row = title.closest<HTMLElement>('li') ?? document.body;
    expect(
      within(row).getByText(
        'Check that it’s turned on and that its connection works, in Settings.',
      ),
    ).toBeVisible();
    expect(screen.queryByText(/dead.?letter|intent/iu)).toBeNull();
  });
});
