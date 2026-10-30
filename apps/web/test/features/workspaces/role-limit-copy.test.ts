import { expect, it } from 'vitest';
import { connectionCommandError } from '@/features/connections/model/connection-errors';
import { destinationCommandError } from '@/features/failure-notifications/model/failure-notification-errors';
import { ApiError } from '@/lib/api/error';

const forbidden = new ApiError({
  kind: 'problem',
  status: 403,
  message: 'Forbidden',
});

// A refusal for a role names who can, as the role policy grants it:
// connections and alert destinations are managed by owners and admins.
it.each(['create', 'rotate', 'revoke'] as const)(
  'names who can %s a connection when the role can’t',
  (command) => {
    expect(connectionCommandError(forbidden, command, 'Slack')).toMatch(
      /^Your role.* can’t .+\. Admins and owners can\.$/u,
    );
  },
);

it.each(['create', 'update', 'enable', 'disable'] as const)(
  'names who can %s an alert destination when the role can’t',
  (command) => {
    expect(destinationCommandError(forbidden, command)).toMatch(
      /^Your role.* can’t .+\. Admins and owners can\.$/u,
    );
  },
);
