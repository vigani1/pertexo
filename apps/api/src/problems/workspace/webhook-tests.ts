import { errorRegistration } from '../../platform/http/problems/registry.js';
import { WebhookTestEventError } from '@pertexo/core/triggers';
import { applicationError } from '../../platform/http/index.js';

export const webhookTestsProblems = [
  errorRegistration(WebhookTestEventError, (error) => {
    return applicationError('workspace.conflict', {
      safeDetail: webhookTestDetail(error.reason),
    });
  }),
];

function webhookTestDetail(reason: WebhookTestEventError['reason']): string {
  if (reason === 'limit_reached')
    return 'Ten webhook test listeners are already open in this workspace. Stop one or wait for it to expire.';
  if (reason === 'changed') return 'Save the current draft and listen again.';
  return 'This saved step is no longer an available webhook trigger.';
}
