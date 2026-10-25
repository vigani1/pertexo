import { fireEvent, screen, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { describe, expect, it } from 'vitest';

import {
  choose,
  findCanvas,
} from '../../../../support/fixtures/editor-actions';
import {
  editorHandlers,
  editorPath,
  workflowSummaryHandler,
} from '../../../../support/fixtures/workflow-editor';

import { mockServer } from '../../../../support/mock-server';

import { renderApp } from '../../../../support/render-app';

import { previewHandler, scheduleDefinition, scheduleGraph } from './fixture';

describe('schedule builder in Setup', { timeout: 30_000 }, () => {
  it('shows the next runs the server works out for the rule on screen', async () => {
    const sent: unknown[] = [];
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph: scheduleGraph({
          kind: 'cron',
          expression: '30 2 * * *',
          timezone: 'America/New_York',
          misfirePolicy: 'catch_up_once',
        }),
        definitions: [scheduleDefinition],
      }),
      workflowSummaryHandler('Nightly schedule', null),
      previewHandler(sent),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Nightly'));
    const preview = screen.getByRole('region', { name: 'When it runs' });
    expect(
      within(preview).getByRole('status', {
        name: 'Working out the next runs',
      }),
    ).toBeVisible();
    const list = await within(preview).findByRole('list', {
      name: 'Next runs if published now',
    });
    const [before, gap, after] = within(list).getAllByRole('listitem');
    // New York's clocks spring forward on 14 March 2027.
    expect(before).toHaveTextContent(/\b0?2:30.*EST/u);
    expect(gap).toHaveTextContent(/\b0?3:00.*EDT/u);
    expect(after).toHaveTextContent(/\b0?2:30.*EDT/u);
    expect(sent).toEqual([
      {
        config: {
          kind: 'cron',
          expression: '30 2 * * *',
          timezone: 'America/New_York',
        },
        count: 3,
      },
    ]);

    await choose(event, 'Runs', 'Custom cron rule');
    fireEvent.change(screen.getByLabelText('Cron rule'), {
      target: { value: '0 25 * * *' },
    });
    expect(
      await within(preview).findByText(
        'Pertexo can’t schedule this rule. Check the cron fields and the timezone.',
      ),
    ).toBeVisible();
    expect(within(preview).queryByRole('list')).not.toBeInTheDocument();
  });
});
