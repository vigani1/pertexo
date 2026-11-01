import { z } from 'zod';

import {
  createWorkspaceInvitationDeliveryStore,
  type WorkspaceInvitationDeliveryStore,
} from '@pertexo/core/tenant-access';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import {
  createApplicationSecretEnvelope,
  type ApplicationSecretEnvelope,
  type SystemMailClient,
} from '@pertexo/integrations/server';
import {
  parseQueueJob,
  type QueueDelivery,
  type QueueHandlerContext,
} from '@pertexo/queue';
import { invitationKeys } from '../../support/better-auth/real-api.support.js';
import type { FixtureResourceOwner } from '../harness/resource-owner.js';

import type { useOrganizationOwnedApi } from '../../workflow-authoring/organization/support/owned-api.fixture.js';
import { webOrigin } from './environment.js';

export async function createOrganizationInvitationDelivery(
  context: Readonly<{
    api: ReturnType<typeof useOrganizationOwnedApi>['api'];
    owner: FixtureResourceOwner;
  }>,
) {
  const { api, owner } = context;

  // Compose the compiled production invitation handler and worker-scoped
  // store; only the external mail provider is captured locally. No token
  // is synthesized or decrypted outside the delivery handler.
  const workerBase = process.env.DATABASE_URL;
  if (workerBase === undefined)
    throw new Error('Explicit owned worker database authority required');
  const databaseName = (
    await api
      .database()
      .query<{ name: string }>('select current_database() name')
  ).rows[0]?.name;
  if (databaseName === undefined)
    throw new Error('Owned invitation database unavailable');
  const workerUrl = new URL(workerBase);
  workerUrl.pathname = `/${databaseName}`;
  const deliveryStore = createWorkspaceInvitationDeliveryStore(
    parseDatabaseConfig({ connectionString: workerUrl.toString(), max: 1 }),
  );
  owner.acquire('invitation delivery store', deliveryStore, () =>
    deliveryStore.close(),
  );
  const deliveredMail = new Map<string, string>();
  owner.acquire('captured invitation mail', deliveredMail, () => {
    deliveredMail.clear();
  });
  // Lazy-load the compiled handler only in the enabled lane. API-only
  // discovery does not require the worker's compiled output to exist.
  type DeliveryFactory = (
    dependencies: Readonly<{
      store: WorkspaceInvitationDeliveryStore;
      envelope: Pick<ApplicationSecretEnvelope, 'open'>;
      email: SystemMailClient;
      fromEmail: string;
      webOrigin: string;
      timeoutMillis: number;
    }>,
  ) => Readonly<{
    handle(
      delivery: Extract<
        QueueDelivery,
        { name: 'deliver-workspace-invitation' }
      >,
      context: QueueHandlerContext,
    ): Promise<void>;
  }>;
  const compiled: unknown = await import(
    new URL(
      '../../../../worker/dist/identity/invitation-delivery.js',
      import.meta.url,
    ).href
  );
  if (
    typeof compiled !== 'object' ||
    compiled === null ||
    !('createWorkspaceInvitationDeliveryHandler' in compiled) ||
    typeof compiled.createWorkspaceInvitationDeliveryHandler !== 'function'
  )
    throw new Error('Compiled canonical invitation handler unavailable');
  const deliveryFactory =
    compiled.createWorkspaceInvitationDeliveryHandler as DeliveryFactory;
  const deliveryHandler = deliveryFactory({
    store: deliveryStore,
    envelope: createApplicationSecretEnvelope(invitationKeys),
    email: {
      deduplicates: true,
      sendNotification: async (input) => {
        await input.beforeDispatch();
        const link = input.text
          .split('\n')
          .find((line) =>
            line.startsWith(`${webOrigin}/invitations/accept#token=`),
          );
        if (link === undefined)
          throw new Error('Canonical invitation mail link unavailable');
        deliveredMail.set(input.toEmail, link);
        return { kind: 'submitted', reference: crypto.randomUUID() };
      },
    },
    fromEmail: 'invites@integration.test',
    webOrigin,
    timeoutMillis: 5000,
  });
  async function deliverInvitation(value: unknown) {
    const { workspaceId, invitationId } = z
      .object({ workspaceId: z.uuid(), invitationId: z.uuid() })
      .strict()
      .parse(value);
    const event = (
      await api
        .database()
        .query<{ id: string; payload: unknown; recipient_email: string }>(
          "select event.id,event.payload,invitation.recipient_email from app.outbox_events event join app.workspace_invitations invitation on invitation.workspace_id=event.workspace_id and invitation.id=event.aggregate_id where event.workspace_id=$1 and event.aggregate_id=$2 and event.job_name='deliver-workspace-invitation' order by event.created_at desc limit 1",
          [workspaceId, invitationId],
        )
    ).rows[0];
    if (event === undefined)
      throw new Error('Canonical invitation outbox event unavailable');
    const job = parseQueueJob({
      name: 'deliver-workspace-invitation',
      data: event.payload,
    });
    if (job.name !== 'deliver-workspace-invitation')
      throw new Error('Canonical invitation job mismatch');
    await deliveryHandler.handle(
      {
        ...job,
        transport: { attemptsMade: 0, jobId: `outbox-${event.id}` },
      },
      { signal: new AbortController().signal },
    );
    const link = deliveredMail.get(event.recipient_email);
    if (link === undefined)
      throw new Error('Canonical invitation was not delivered');
    deliveredMail.delete(event.recipient_email);
    const url = new URL(link);
    return { path: url.pathname + url.hash };
  }
  return { deliverInvitation };
}
