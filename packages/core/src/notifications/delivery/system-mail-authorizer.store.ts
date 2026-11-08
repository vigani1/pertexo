import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import {
  runFailureNotificationIntents as intents,
  failureNotificationDestinations as destinations,
  failureNotificationDestinationVersions as versions,
} from '@pertexo/database/schema';
import { rolesForCapability } from '@pertexo/policy';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { lockWorkspaceAuthority } from '../../shared/authority.repository.js';
import { WorkspaceAccessDeniedError } from '../../shared/workspace-access.errors.js';
import { destinationConfigSql } from '../destinations/notification-destinations.repository.js';
import { readSystemMailRecipient } from './system-mail-recipient.repository.js';

/** No actor sends this mail: the member is its addressee, as with system notices. */
export function createFailureNotificationMailAuthorizer(
  config: DatabaseConfig,
  maintenanceConfig: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  const maintenance = acquireDatabasePool(maintenanceConfig);
  return {
    close: async () => {
      await lease.close();
      await maintenance.close();
    },
    authorize: async (id: string, toEmail: string): Promise<boolean> => {
      const [addressed] = await drizzle(maintenance.pool)
        .select({
          workspaceId: intents.workspaceId,
          config: destinationConfigSql,
        })
        .from(intents)
        .innerJoin(
          versions,
          and(
            eq(versions.workspaceId, intents.workspaceId),
            eq(versions.destinationId, intents.destinationId),
            eq(versions.version, intents.destinationConfigVersion),
          ),
        )
        .where(eq(intents.id, id));
      if (addressed?.config.kind !== 'system_mail') return false;
      const memberId = addressed.config.memberId;
      try {
        return await withTenantScopedClient(
          lease.pool,
          { workspaceId: addressed.workspaceId, actorId: memberId },
          async (client) => {
            await lockWorkspaceAuthority(
              client,
              addressed.workspaceId,
              memberId,
              rolesForCapability('workspace:read'),
            );
            const db = drizzle(client);
            const [current] = await db
              .select({ id: intents.id })
              .from(intents)
              .innerJoin(
                destinations,
                and(
                  eq(destinations.workspaceId, intents.workspaceId),
                  eq(destinations.id, intents.destinationId),
                ),
              )
              .where(
                and(
                  eq(intents.workspaceId, addressed.workspaceId),
                  eq(intents.id, id),
                  eq(intents.status, 'claimed'),
                  eq(destinations.status, 'enabled'),
                  eq(
                    destinations.currentConfigVersion,
                    intents.destinationConfigVersion,
                  ),
                ),
              )
              .for('share');
            if (current === undefined) return false;
            const recipient = await readSystemMailRecipient(
              db,
              addressed.workspaceId,
              memberId,
            );
            return recipient?.verified === true && recipient.email === toEmail;
          },
        );
      } catch (error) {
        if (error instanceof WorkspaceAccessDeniedError) return false;
        throw error;
      }
    },
  };
}
