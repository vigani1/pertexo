import { apiProblemSchema } from '@pertexo/contracts';
import { WebhookTriggerStateError } from '@pertexo/core/triggers';
import { describe, expect, it } from 'vitest';

import {
  ProblemDetailsFilter,
  RequestContextStore,
} from '../../src/platform/http/index.js';
import { toProblem } from '../../src/problems/registry.js';
import {
  hostFor,
  responseMock,
} from '../platform/http/problem-details.filter/fixture.js';

function render(reason: WebhookTriggerStateError['reason']) {
  const contexts = new RequestContextStore();
  const filter = new ProblemDetailsFilter(contexts);
  const response = responseMock();
  contexts.run('request-webhook-state', () => {
    filter.catch(
      toProblem(new WebhookTriggerStateError(reason)),
      hostFor({ url: '/v1/workflows/w/webhook/provision' }, response),
    );
  });
  return response;
}

describe('a webhook that cannot take an endpoint yet', () => {
  it('tells a client when to come back while it is being set up', () => {
    const response = render('setting_up');

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.header).toHaveBeenCalledWith('retry-after', '5');
    expect(response.body).toMatchObject({ code: 'workspace.conflict' });
    expect(apiProblemSchema.safeParse(response.body).success).toBe(true);
  });

  it.each(['provisioned', 'unavailable'] as const)(
    'sends no retry time when it is %s, since waiting will not help',
    (reason) => {
      const response = render(reason);

      expect(response.status).toHaveBeenCalledWith(409);
      expect(response.header).not.toHaveBeenCalledWith(
        'retry-after',
        expect.anything(),
      );
    },
  );
});
