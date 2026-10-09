import { isApiError } from '@/lib/api/api-error';
import {
  describeCommandError,
  isUncertainOutcome,
} from '@/lib/api/api-error-copy';

type DestinationCommand = 'create' | 'update' | 'enable' | 'disable';

const ACTIONS: Readonly<Record<DestinationCommand, string>> = {
  create: 'adding this destination',
  update: 'saving this destination',
  enable: 'turning these alerts on',
  disable: 'turning these alerts off',
};

const UNCERTAIN: Readonly<Record<DestinationCommand, string>> = {
  create:
    'We couldn’t confirm whether the destination was added. Try again — it can’t be added twice.',
  update:
    'We couldn’t confirm whether your changes were saved. Try again — they can’t be saved twice.',
  enable:
    'We couldn’t confirm whether these alerts turned on. Try again — it repeats the same request.',
  disable:
    'We couldn’t confirm whether these alerts turned off. Try again — it repeats the same request.',
};

/** Someone saved a newer version while this edit was open. */
export function isDestinationConflict(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.status === 412 ||
      (error.status === 409 && error.problem?.code === 'connection.conflict'))
  );
}

export function destinationCommandError(
  error: unknown,
  command: DestinationCommand,
): string {
  if (isUncertainOutcome(error)) return UNCERTAIN[command];
  if (isDestinationConflict(error))
    return command === 'update'
      ? 'Someone changed this destination while you were editing. Load the latest version, then save again — your edits stay.'
      : 'Pertexo couldn’t use this connection for alerts. Check it still works, then try again.';
  if (
    isApiError(error) &&
    error.problem?.code === 'request.idempotency_conflict'
  )
    return 'This request was already used with different details. Try again.';
  if (isApiError(error) && (error.status === 403 || error.status === 404))
    return 'Your role can’t change alert destinations. Admins and owners can.';
  return describeCommandError(error, ACTIONS[command]);
}
