import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import { noticeMailBatches } from '@pertexo/database/schema';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';

import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';
import { authorizeBatch } from './authorize.repository.js';
import { readMailCandidates } from './candidates.queries.js';
import type { NoticeMailPerson, NoticeMailSealer } from './contract.js';
import { preparePerson } from './prepare.repository.js';

const CANDIDATE_PAGE_SIZE = 10;
const STATEMENT_TIMEOUT_MILLIS = 5_000;

export type NoticeMailStore = ReturnType<typeof createNoticeMailStore>;

/**
 * The worker writes and sends notice mail. Nobody is acting: each person is the
 * mail's addressee, so this stays off `withWorkspaceAccess`. Their authority is
 * still checked, and losing it means no mail rather than an error.
 */
export function createNoticeMailStore(
  config: DatabaseConfig,
  maintenanceConfig: DatabaseConfig,
  seal: NoticeMailSealer,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  const maintenance = acquireDatabasePool(maintenanceConfig);
  let after: NoticeMailPerson | undefined;
  const asPerson = (person: NoticeMailPerson) => ({
    workspaceId: person.workspace_id,
    actorId: person.user_id,
  });
  return {
    close: async () => {
      await lease.close();
      await maintenance.close();
    },
    prepare: async (signal?: AbortSignal): Promise<number> => {
      signal?.throwIfAborted();
      const candidates = await readMailCandidates(
        maintenance.pool,
        after,
        CANDIDATE_PAGE_SIZE,
      );
      let count = 0;
      for (const person of candidates) {
        signal?.throwIfAborted();
        try {
          count += await withTenantScopedClient(
            lease.pool,
            asPerson(person),
            (client) => preparePerson(client, person, seal),
            {
              statementTimeoutMillis: STATEMENT_TIMEOUT_MILLIS,
              ...(signal === undefined ? {} : { signal }),
            },
          );
        } catch (error) {
          if (!(error instanceof WorkspaceAccessDeniedError)) throw error;
        }
        after = person;
      }
      if (candidates.length < CANDIDATE_PAGE_SIZE) after = undefined;
      return count;
    },
    authorize: async (deliveryId: string) => {
      const [person] = await drizzle(maintenance.pool)
        .select({
          workspace_id: noticeMailBatches.workspaceId,
          user_id: noticeMailBatches.userId,
        })
        .from(noticeMailBatches)
        .where(eq(noticeMailBatches.id, deliveryId))
        .catch(rethrowQueryFailure);
      if (person === undefined) return false;
      try {
        return await withTenantScopedClient(
          lease.pool,
          asPerson(person),
          (client) => authorizeBatch(client, person, deliveryId),
          { statementTimeoutMillis: STATEMENT_TIMEOUT_MILLIS },
        );
      } catch (error) {
        if (error instanceof WorkspaceAccessDeniedError) return false;
        throw error;
      }
    },
  };
}
