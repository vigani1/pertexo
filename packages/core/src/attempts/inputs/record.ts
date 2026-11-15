import { withTenantScopedClient } from '@pertexo/database/primitives';
import { serializeStoredExecutionValue } from '../../shared/stored-execution.js';
import type { Pool } from 'pg';
import type { RecordInputInput } from '../node-attempt.js';
import { writeLeasedAttemptInput } from './leased-inputs.repository.js';

/**
 * Writes an attempt's resolved input onto its node run while the caller still
 * holds the attempt, under the heartbeat's own predicate (ADR 052). Anything
 * that stops it, an input over the inline bound, a lost lease or a failed
 * write, records nothing: the input is diagnostic and never changes the
 * attempt.
 */
export async function recordNodeAttemptInput(
  pool: Pool,
  request: RecordInputInput,
): Promise<Readonly<{ recorded: boolean }>> {
  if (request.signal.aborted) return { recorded: false };
  const { lease, signal } = request;
  let stored: string;
  try {
    stored = serializeStoredExecutionValue({
      kind: 'inline',
      value: request.input,
    });
  } catch {
    return { recorded: false };
  }
  try {
    return await withTenantScopedClient(
      pool,
      { workspaceId: lease.workspaceId },
      async (client) => {
        return {
          recorded: await writeLeasedAttemptInput(client, lease, stored),
        };
      },
      { signal: signal },
    );
  } catch {
    return { recorded: false };
  }
}
