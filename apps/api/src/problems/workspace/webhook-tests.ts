import { errorRegistration } from '../../platform/http/problems/registry.js';
import { WebhookTestEventError } from '@pertexo/database/triggers';
import { applicationError } from '../../platform/http/index.js';

export const webhookTestsProblems = [
  errorRegistration(WebhookTestEventError, (error) => {
    return applicationError('workspace.conflict', {
      safeDetail:
        error.reason === 'limit_reached'
          ? 'Ten webhook test listeners are already open in this workspace. Stop one or wait for it to expire.'
          : error.reason === 'changed'
            ? 'Save the current draft and listen again.'
            : 'This saved step is no longer an available webhook trigger.',
    });
  }),
];
