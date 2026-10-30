import type { ApiProblemCode } from '@pertexo/contracts';
import { isUnconfirmedCommand } from '@/lib/api/commands/contract';
import { isApiError } from '@/lib/api/error';
import { describeCommandError, isForbidden } from '@/lib/api/error-copy';
import { refusalWhoCan } from '@/features/workspaces/roles.public';

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
      `We couldn’t confirm whether ${name} was saved. Try again — Pertexo recognizes the repeat, so it can’t be saved twice.`,
    rotate: () =>
      'We couldn’t confirm whether the new credential was saved. Try again with the same values — it can’t be applied twice.',
    revoke: (name) =>
      `We couldn’t confirm whether ${name} was revoked. Check the list before trying again.`,
    test: () =>
      'We couldn’t confirm the test result. Test again — it repeats the same request.',
  };

const FORBIDDEN: Readonly<Record<ConnectionCommand, string>> = {
  create: `Your role can’t add connections. ${refusalWhoCan('connection:manage')}`,
  rotate: `Your role can’t replace credentials. ${refusalWhoCan('connection:manage')}`,
  revoke: `Your role can’t revoke connections. ${refusalWhoCan('connection:manage')}`,
  test: 'Your role can’t test connections.',
};

const SPECIFIC_PROBLEMS: Readonly<
  Partial<
    Record<ApiProblemCode, (command: ConnectionCommand, name: string) => string>
  >
> = {
  'connection.revoked': (_command, name) =>
    `${name} was revoked, so it can’t be used or changed.`,
  'connection.conflict': (command, name) =>
    command === 'rotate'
      ? 'Someone replaced this credential meanwhile. Close this and start again from the latest version.'
      : `${name} changed meanwhile. Reload and try again.`,
  'request.idempotency_conflict': () =>
    'This request was already used with different details. Start again.',
};

/** One sentence for a failed connection command, naming what to do next. */
export function connectionCommandError(
  error: unknown,
  command: ConnectionCommand,
  name: string,
): string {
  if (isUnconfirmedCommand(error)) return UNCERTAIN[command](name);
  if (isForbidden(error)) return FORBIDDEN[command];
  if (isApiError(error)) {
    const code = error.problem?.code;
    const describe = code === undefined ? undefined : SPECIFIC_PROBLEMS[code];
    if (describe !== undefined) return describe(command, name);
  }

  return describeCommandError(error, ACTIONS[command]);
}
