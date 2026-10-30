import { createEditorNotifications } from '../notifications/runtime.js';
import { createMaintenanceRuntime } from '../../../../src/maintenance/runtime.js';

import { parseDatabaseConfig } from '@pertexo/database/testing';

import { curatedCoordinatorConsumerFactory } from '../../curated-templates/coordinator-diagnostic.js';

import type { EditorWorkerExecution } from './contract.js';
import { errorWorkflowCase, curatedTemplates } from './environment.js';
import { testCoordinatorRuntime } from '../../runtime-factories.js';

export async function startEditorCoordinator(context: EditorWorkerExecution) {
  const { raw, database, namespace, resources, assertSetupActive } = context;
  if (
    [
      'approvals',
      'forms',
      'variables',
      'notifications',
      'collaboration',
    ].includes(process.env.EDITOR_BROWSER_CASE ?? '')
  ) {
    const notifications = await createEditorNotifications(
      database,
      parseDatabaseConfig({ connectionString: raw.dispatcherUrl, max: 1 }),
      namespace.redisUrl,
      process.env.EDITOR_BROWSER_CASE === 'notifications'
        ? {
            key: process.env.EDITOR_BROWSER_NOTICE_MAIL_KEY ?? '',
            publicWebOrigin:
              process.env.EDITOR_BROWSER_NOTICE_PUBLIC_ORIGIN ?? '',
          }
        : undefined,
    );
    resources.notifications = notifications;
    notifications.start();
    await notifications.checkReadiness();
    assertSetupActive();
  }
  const coordinator = await testCoordinatorRuntime(
    {
      maintenanceDatabase: parseDatabaseConfig({
        connectionString: raw.dispatcherUrl,
        max: 2,
      }),
      database,
      maximumAdmissions: 10,
      redisUrl: namespace.redisUrl,
    },
    curatedTemplates
      ? {
          consumerFactory: curatedCoordinatorConsumerFactory((value) => {
            process.stderr.write(
              `Owned curated coordinator failure ${JSON.stringify(value)}\n`,
            );
          }),
        }
      : {},
  );
  resources.coordinator = coordinator;
  if (errorWorkflowCase) {
    const maintenance = await createMaintenanceRuntime({
      database,
      redisUrl: namespace.redisUrl,
    });
    resources.maintenance = maintenance;
    await maintenance.consumer.waitUntilReady(5_000);
    assertSetupActive();
  }
  assertSetupActive();

  return coordinator;
}
