import { isApiError } from '@/lib/api/api-error';
import {
  describeCommandError,
  isForbidden,
  isUncertainOutcome,
} from '@/lib/api/api-error-copy';

type ConnectionCommand = 'create' | 'rotate' | 'revoke' | 'test';

const ACTIONS: Readonly<Record<ConnectionCommand, string>> = {
  create: 'saving this connection',
  rotate: 'replacing the credential',
  revoke: 'revoking this connection',
  test: 'testing this connection',
};

const UNCERTAIN: Readonly<Record<ConnectionCommand, (name: string) => string>> =
  {
    create: (name) =>
      `We couldn’t confirm whether ${name} was saved. Try again — Pertexo recognises the repeat, so it can’t be saved twice.`,
    rotate: () =>
      'We couldn’t confirm whether the new credential was saved. Try again with the same values — it can’t be applied twice.',
    revoke: (name) =>
      `We couldn’t confirm whether ${name} was revoked. Check the list before trying again.`,
    test: () =>
      'We couldn’t confirm the test result. Test again — it repeats the same request.',
  };

const FORBIDDEN: Readonly<Record<ConnectionCommand, string>> = {
  create: 'Your role can’t add connections. Admins and owners can.',
  rotate: 'Your role can’t replace credentials. Admins and owners can.',
  revoke: 'Your role can’t revoke connections. Admins and owners can.',
  test: 'Your role can’t test connections.',
};

/** One sentence for a failed connection command, naming what to do next. */
export function connectionCommandError(
  error: unknown,
  command: ConnectionCommand,
  name: string,
): string {
  if (isUncertainOutcome(error)) return UNCERTAIN[command](name);
  if (isForbidden(error)) return FORBIDDEN[command];
  if (isApiError(error)) {
    switch (error.problem?.code) {
      case 'connection.revoked':
        return `${name} was revoked, so it can’t be used or changed.`;
      case 'connection.reauthorization_required':
        return `${name} needs a new credential. Replace it, then test again.`;
      case 'connection.conflict':
        return command === 'rotate'
          ? 'Someone replaced this credential meanwhile. Close this and start again from the latest version.'
          : `${name} changed meanwhile. Reload and try again.`;
      case 'request.idempotency_conflict':
        return 'This request was already used with different details. Start again.';
      default:
        break;
    }
  }
  return describeCommandError(error, ACTIONS[command]);
}
