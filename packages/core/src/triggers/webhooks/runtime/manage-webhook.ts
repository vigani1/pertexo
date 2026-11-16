import { createHash } from 'node:crypto';

import type { Pool } from 'pg';

import { refreshWorkflowActivation } from '../../reconciliation/health.repository.js';

import {
  WebhookTriggerNotFoundError,
  WebhookTriggerStateError,
  requireWebhookTrigger,
} from '../webhook-trigger.errors.js';

import { withTriggerManagement } from '../../management.js';
import {
  authenticationChangeRotates,
  provisionRefusal,
} from './endpoint.js';
import type {
  ConfigureWebhookAuthenticationInput,
  ProvisionWebhookInput,
  RotateWebhookEndpointInput,
  RotateWebhookSecretInput,
  WebhookCommandResult,
} from './webhook-runtime.types.js';
import {
  claimWebhookCommand,
  completeWebhookCommand,
  insertSecret,
} from './receipts.repository.js';
import { oneHealth } from './webhook-state.js';

import {
  activateWebhookTrigger,
  insertEndpoint,
  lockEndpointAuthentication,
  lockEndpointSecret,
  lockWebhookTrigger,
  replaceEndpointAuthentication,
  rotateEndpointKey,
  rotateEndpointSecret,
  updateEndpointAuthentication,
} from './management.repository.js';

export function configureWebhookAuthentication(
  pool: Pool,
  input: ConfigureWebhookAuthenticationInput,
): Promise<WebhookCommandResult & Readonly<{ rotated: boolean }>> {
  return withTriggerManagement(
    pool,
    input,
    () => new WebhookTriggerNotFoundError(),
    async (client) => {
      const operation = 'webhook.trigger.authentication.configure';
      if (await claimWebhookCommand(client, input, operation))
        return {
          trigger: await oneHealth(client, input.workspaceId, input.triggerId),
          replayed: true,
          rotated: false,
        };
      const current = await lockEndpointAuthentication(client, input);
      if (current === undefined) throw new WebhookTriggerNotFoundError();
      const next = input.authentication;
      const rotated = authenticationChangeRotates(current, next);
      if (rotated) {
        const secret = requireWebhookTrigger(
          await insertSecret(client, input, input.secret),
        );
        await replaceEndpointAuthentication(client, input, secret.id);
      } else {
        await updateEndpointAuthentication(client, input);
      }
      await completeWebhookCommand(client, input, operation);
      return {
        trigger: await oneHealth(client, input.workspaceId, input.triggerId),
        replayed: false,
        rotated,
      };
    },
  );
}

export function provisionWebhook(
  pool: Pool,
  input: ProvisionWebhookInput,
): Promise<WebhookCommandResult> {
  return withTriggerManagement(
    pool,
    input,
    () => new WebhookTriggerNotFoundError(),
    async (client) => {
      const operation = 'webhook.trigger.provision';
      if (await claimWebhookCommand(client, input, operation))
        return {
          trigger: await oneHealth(client, input.workspaceId, input.triggerId),
          replayed: true,
        };
      const row = await lockWebhookTrigger(client, input);
      if (row === undefined) throw new WebhookTriggerNotFoundError();
      const refusal = provisionRefusal(row.status);
      if (refusal !== undefined) throw new WebhookTriggerStateError(refusal);
      const secret = requireWebhookTrigger(
        await insertSecret(client, input, input.secret),
      );
      await insertEndpoint(client, input, row, secret.id);
      await activateWebhookTrigger(client, input);
      await refreshWorkflowActivation(
        client,
        input.workspaceId,
        row.workflow_id,
      );
      await completeWebhookCommand(client, input, operation);
      return {
        trigger: await oneHealth(client, input.workspaceId, input.triggerId),
        replayed: false,
      };
    },
  );
}

export function rotateWebhookEndpoint(
  pool: Pool,
  input: RotateWebhookEndpointInput,
): Promise<WebhookCommandResult> {
  return withTriggerManagement(
    pool,
    input,
    () => new WebhookTriggerNotFoundError(),
    async (client) => {
      const operation = 'webhook.trigger.endpoint.rotate';
      if (await claimWebhookCommand(client, input, operation))
        return {
          trigger: await oneHealth(client, input.workspaceId, input.triggerId),
          replayed: true,
        };
      if (!(await rotateEndpointKey(client, input)))
        throw new WebhookTriggerNotFoundError();
      await completeWebhookCommand(client, input, operation);
      return {
        trigger: await oneHealth(client, input.workspaceId, input.triggerId),
        replayed: false,
      };
    },
  );
}

export function rotateWebhookSecret(
  pool: Pool,
  input: RotateWebhookSecretInput,
): Promise<WebhookCommandResult> {
  return withTriggerManagement(
    pool,
    input,
    () => new WebhookTriggerNotFoundError(),
    async (client) => {
      const operation = 'webhook.trigger.secret.rotate';
      const keyedCommand = {
        ...input,
        requestHash: createHash('sha256')
          .update(`${input.requestHash}\0${input.endpointKeyHash}`)
          .digest('hex'),
      };
      if (await claimWebhookCommand(client, keyedCommand, operation))
        return {
          trigger: await oneHealth(client, input.workspaceId, input.triggerId),
          replayed: true,
        };
      const row = await lockEndpointSecret(client, input);
      if (row === undefined || row.authentication.mode === 'secret_url')
        throw new WebhookTriggerNotFoundError();
      const current = row.current_secret_version_id;
      const secret = requireWebhookTrigger(
        await insertSecret(client, input, input.secret),
      );
      await rotateEndpointSecret(client, input, secret.id, current);
      await completeWebhookCommand(client, keyedCommand, operation);
      return {
        trigger: await oneHealth(client, input.workspaceId, input.triggerId),
        replayed: false,
      };
    },
  );
}
