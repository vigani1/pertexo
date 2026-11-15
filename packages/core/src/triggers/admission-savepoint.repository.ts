import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { sql } from 'drizzle-orm';

/** One savepoint per way a trigger admits a run. */
type AdmissionSavepoint =
  | 'coordinated_run_admission'
  | 'release_coordinated_run'
  | 'form_run_admission'
  | 'schedule_run_admission'
  | 'webhook_run_admission';

export type SavepointAdmission<T> =
  | Readonly<{ admitted: true; value: T }>
  | Readonly<{ admitted: false; error: unknown }>;

/**
 * Admits a run inside a savepoint, so a refusal `recoverable` accepts undoes
 * only the admission and the trigger can record why. Any other failure is
 * thrown with the savepoint left for the transaction to roll back.
 */
export async function admitInSavepoint<T>(
  transaction: WorkspaceTransaction,
  name: AdmissionSavepoint,
  admit: () => Promise<T>,
  recoverable: (error: unknown) => boolean,
): Promise<SavepointAdmission<T>> {
  const savepoint = sql.raw(name);
  await transaction.db
    .execute(sql`savepoint ${savepoint}`)
    .catch(rethrowQueryFailure);
  try {
    const value = await admit();
    await transaction.db
      .execute(sql`release savepoint ${savepoint}`)
      .catch(rethrowQueryFailure);
    return { admitted: true, value };
  } catch (error) {
    if (!recoverable(error)) throw error;
    await transaction.db
      .execute(sql`rollback to savepoint ${savepoint}`)
      .catch(rethrowQueryFailure);
    await transaction.db
      .execute(sql`release savepoint ${savepoint}`)
      .catch(rethrowQueryFailure);
    return { admitted: false, error };
  }
}
