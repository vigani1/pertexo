import { useNow } from '../../hooks/use-now';
import { COMMAND_RETRY_WINDOW_MS, type CommandKey } from './contract';

/**
 * Whether a held command's retry window has ended, re-rendering the moment it
 * does. `undefined` means no command is held.
 */
export function useResendExpired(
  held: Pick<CommandKey, 'createdAt'> | undefined,
): boolean {
  const until =
    held === undefined ? undefined : held.createdAt + COMMAND_RETRY_WINDOW_MS;
  const now = useNow({
    intervalMs: 1000,
    enabled: until !== undefined,
    untilMs: until,
  });
  return until !== undefined && now >= until;
}
