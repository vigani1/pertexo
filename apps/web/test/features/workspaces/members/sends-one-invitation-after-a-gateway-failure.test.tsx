import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  api,
  firstMemberId,
  identityHandlers,
  member,
  membersOf,
  noInvitations,
  ownerWorkspace,
  workspaceId,
} from '../../../support/fixtures/team';
import { gatewayFailures } from '../../../support/fixtures/gateway-failures';
import { mockServer } from '../../../support/mock-server';
import { renderLoadedApp } from '../../../support/render-app';
import { invitation, lens, sheet } from './fixture';

describe('team: invitations after a gateway failure', () => {
  it.each(gatewayFailures)(
    'sends one invitation when the person tries again after a %s',
    async (_status, gatewayFailure) => {
      // The server keeps one invitation per idempotency key, like the API does.
      const sent = new Map<string | null, unknown>();
      let posts = 0;
      mockServer.use(
        ...identityHandlers(ownerWorkspace),
        membersOf(() => [member(firstMemberId, 'Ada Operator', 'viewer')]),
        noInvitations(),
        http.post(`${api}/invitations`, async ({ request }) => {
          posts += 1;
          const key = request.headers.get('idempotency-key');
          const replayed = sent.has(key);
          sent.set(key, await request.json());
          return posts === 1
            ? gatewayFailure()
            : HttpResponse.json(
                { invitation: invitation('new.member@example.test'), replayed },
                { status: 202 },
              );
        }),
      );
      const browser = userEvent.setup();
      await renderLoadedApp(`/w/${workspaceId}/team`, { strict: true });
      await browser.click(
        await screen.findByRole('button', { name: 'Invite people' }),
      );
      await browser.type(
        lens().getByLabelText('Email addresses'),
        'new.member@example.test',
      );
      await browser.click(
        lens().getByRole('button', { name: 'Send invitation' }),
      );
      expect(await lens().findByRole('alert')).toHaveTextContent(
        'We couldn’t confirm whether the invitation to new.member@example.test went through',
      );
      // Only the exact retry is offered; a fresh send could invite twice.
      expect(
        lens().queryByRole('button', { name: /^Send/u }),
      ).not.toBeInTheDocument();

      await browser.click(lens().getByRole('button', { name: 'Try again' }));

      await waitFor(() => {
        expect(sheet()).not.toBeInTheDocument();
      });
      expect(
        await screen.findByText('Invitation sent to new.member@example.test'),
      ).toBeVisible();
      expect(posts).toBe(2);
      expect(sent.size).toBe(1);
      expect([...sent.keys()][0]).toBeTruthy();
      expect([...sent.values()]).toEqual([
        { email: 'new.member@example.test', role: 'viewer' },
      ]);
    },
  );
});
