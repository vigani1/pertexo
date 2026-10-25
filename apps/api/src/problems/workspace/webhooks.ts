import { CallbackResponseError } from '@pertexo/database/runs';
import { errorRegistration } from '../../platform/http/problems/registry.js';
import {
  WebhookTriggerIdempotencyConflictError,
  WebhookTriggerNotFoundError,
  WebhookTriggerStateError,
} from '@pertexo/database/triggers';
import { applicationError } from '../../platform/http/index.js';
import { InvalidWebhookDeliveryCursorError } from '../../webhooks/management/cursor.js';

export const webhooksProblems = [
  errorRegistration(CallbackResponseError, (error) =>
    applicationError(
      error.reason === 'resolved'
        ? 'callback.already_received'
        : 'callback.expired',
    ),
  ),
  errorRegistration(InvalidWebhookDeliveryCursorError, () => {
    return applicationError('request.invalid', {
      safeDetail: 'The delivery cursor is invalid.',
    });
  }),
  errorRegistration(WebhookTriggerNotFoundError, () => {
    return applicationError('resource.not_found');
  }),
  errorRegistration(WebhookTriggerStateError, (error) => {
    return applicationError('workspace.conflict', {
      safeDetail: TRIGGER_STATE_COPY[error.reason],
    });
  }),
  errorRegistration(WebhookTriggerIdempotencyConflictError, () => {
    return applicationError('request.idempotency_conflict', {
      safeDetail: 'The idempotency key was already used for another request.',
    });
  }),
];

const TRIGGER_STATE_COPY = {
  setting_up:
    'This webhook is still being set up after publishing. Try again in a few seconds.',
  provisioned:
    'This webhook already has an endpoint. Replace its address to get a new one.',
  unavailable:
    'This webhook can’t take an endpoint while its trigger is off or failing.',
} as const;
