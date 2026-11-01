import {
  WebhookDeliveryIneligibleError,
  WebhookDeliveryReplayMismatchError,
  WebhookIngressRateLimitExceededError,
  WebhookWorkflowPausedError,
  WorkspaceRunQuotaExceededError,
} from '@pertexo/core/testing';

import { expect, it } from 'vitest';

import { currentSecret } from '../environment.js';
import type { Scenario } from '../contract.js';
import { request } from '../requests.js';
import type { createDeliveryLogFixture } from '../examples.js';

export function registerRecordsNameMetadataSameResponse(
  caseFixture: ReturnType<typeof createDeliveryLogFixture>,
): void {
  const { stale, staleSignature, mismatch, verified, setup, endpoint } =
    caseFixture;

  it.each<Scenario>([
    {
      name: 'a stale timestamp',
      headers: {
        'x-pertexo-timestamp': stale,
        'x-pertexo-signature': staleSignature,
      },
      status: 401,
      fact: {
        outcome: 'authentication_failed',
        signatureCheck: 'not_checked',
        replayCheck: 'stale_timestamp',
      },
    },
    {
      name: 'a signature mismatch',
      headers: { 'x-pertexo-signature': mismatch },
      status: 401,
      fact: {
        outcome: 'authentication_failed',
        signatureCheck: 'mismatch',
        replayCheck: 'not_checked',
      },
    },
    {
      name: 'malformed JSON',
      body: '{',
      status: 400,
      fact: {
        ...verified,
        outcome: 'invalid_request',
        replayCheck: 'not_checked',
      },
    },
    {
      name: 'a malformed idempotency key',
      headers: { 'idempotency-key': 'one,two' },
      status: 400,
      fact: {
        ...verified,
        outcome: 'invalid_request',
        replayCheck: 'not_checked',
      },
    },
    {
      name: 'an idempotency conflict',
      acceptanceError: new WebhookDeliveryReplayMismatchError(),
      status: 409,
      fact: { ...verified, outcome: 'conflict', replayCheck: 'conflict' },
    },
    {
      name: 'run admission throttling',
      acceptanceError: new WorkspaceRunQuotaExceededError(),
      status: 429,
      fact: { ...verified, outcome: 'rate_limited', replayCheck: 'new' },
    },
    {
      name: 'a paused workflow',
      acceptanceError: new WebhookWorkflowPausedError(),
      status: 423,
      fact: { ...verified, outcome: 'paused', replayCheck: 'new' },
    },
    {
      name: 'an endpoint that stopped accepting',
      acceptanceError: new WebhookDeliveryIneligibleError(),
      status: 401,
      fact: {
        ...verified,
        outcome: 'authentication_failed',
        replayCheck: 'new',
      },
    },
  ])('records $name as metadata with the same response', async (scenario) => {
    const body = scenario.body ?? '{}';
    const fixture = setup({
      reference: undefined,
      acceptanceError: scenario.acceptanceError,
    });
    const base = request(body, currentSecret);
    const response = await fixture.application.inject({
      ...base,
      headers: { ...base.headers, ...scenario.headers },
    });

    expect(response.statusCode).toBe(scenario.status);
    expect(
      fixture.database.recordRejectedDelivery,
    ).toHaveBeenCalledExactlyOnceWith({
      endpoint,
      ...scenario.fact,
      bodyBytes: Buffer.byteLength(body),
    });
  });

  it('records nothing it cannot attribute', async () => {
    const unknown = setup({});
    unknown.database.resolveVerification.mockResolvedValueOnce(null);
    const limited = setup({});
    limited.database.consumeIngressLimit.mockRejectedValueOnce(
      new WebhookIngressRateLimitExceededError(3),
    );
    const accepted = setup({});
    const fixtures = [unknown, limited, accepted];
    const responses = await Promise.all(
      fixtures.map(({ application }) =>
        application.inject(request('{"size":1}', currentSecret)),
      ),
    );

    expect(responses.map(({ statusCode }) => statusCode)).toEqual([
      401, 429, 202,
    ]);
    for (const fixture of fixtures)
      expect(fixture.database.recordRejectedDelivery).not.toHaveBeenCalled();
    expect(accepted.database.acceptVerifiedDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ bodyBytes: 10 }),
    );
  });

  it('keeps the response when the delivery log cannot be written', async () => {
    const fixture = setup({});
    fixture.database.recordRejectedDelivery.mockRejectedValueOnce(
      new Error('delivery log unavailable'),
    );
    const base = request('{}', currentSecret);
    const response = await fixture.application.inject({
      ...base,
      headers: { ...base.headers, 'x-pertexo-signature': mismatch },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ code: string }>().code).toBe(
      'webhook.authentication_failed',
    );
    expect(response.body).not.toContain('delivery log unavailable');
  });
}
