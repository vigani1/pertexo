import {
  WebhookDeliveryIneligibleError,
  WebhookDeliveryReplayMismatchError,
  WebhookWorkflowPausedError,
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
} from '@pertexo/core/testing';

import { expect, it } from 'vitest';

import {
  currentSecret,
  previousSecret,
  now,
  verification,
} from '../environment.js';
import { request } from '../requests.js';
import type { createIngressFixture } from '../fixture.js';

export function registerAcceptsCaseInsensitiveJSONMediaTypeUTF(
  caseFixture: ReturnType<typeof createIngressFixture>,
): void {
  const { setup } = caseFixture;

  it('accepts case-insensitive JSON media type and UTF-8 parameter', async () => {
    const { application } = setup({});
    const base = request('{}', currentSecret);
    const response = await application.inject({
      ...base,
      headers: {
        ...base.headers,
        'content-type': 'APPLICATION/JSON ; CHARSET=UTF-8',
      },
    });
    expect(response.statusCode).toBe(202);
  });

  it('enforces the exact 256 KiB limit', async () => {
    const { application } = setup({});
    const accepted = '{}'.padEnd(256 * 1024, ' ');
    expect(
      (await application.inject(request(accepted, currentSecret))).statusCode,
    ).toBe(202);
    const body = ' '.repeat(256 * 1024 + 1);
    const response = await application.inject(request(body, currentSecret));
    expect(response.statusCode).toBe(413);
    expect(response.json<{ code: string }>().code).toBe(
      'webhook.payload_too_large',
    );
    const parserRejected = await application.inject(
      request(' '.repeat(256 * 1024 + 10), currentSecret),
    );
    expect(parserRejected.statusCode).toBe(413);
    expect(parserRejected.json<{ code: string }>().code).toBe(
      'webhook.payload_too_large',
    );
  });

  it('accepts the eligible previous secret and rejects it at the persisted boundary', async () => {
    const first = setup({});
    expect(
      (await first.application.inject(request('{}', previousSecret)))
        .statusCode,
    ).toBe(202);
    const prior = verification.previousSecret;
    if (prior === undefined)
      throw new Error('Previous secret fixture is missing');
    const second = setup({
      reference: {
        ...verification,
        previousSecret: { ...prior, validUntil: now },
      },
    });
    expect(
      (await second.application.inject(request('{}', previousSecret)))
        .statusCode,
    ).toBe(401);
  });

  it('wipes the current secret when opening the eligible previous secret fails', async () => {
    const fixture = setup({});
    const openedCurrent = Buffer.alloc(32, 4);
    fixture.openSecret
      .mockReset()
      .mockResolvedValueOnce(openedCurrent)
      .mockRejectedValueOnce(new Error('previous secret unavailable'));

    const response = await fixture.application.inject(
      request('{}', currentSecret),
    );

    expect(response.statusCode).toBe(503);
    expect(Array.from(openedCurrent)).toEqual(Array.from(new Uint8Array(32)));
    expect(fixture.database.acceptVerifiedDelivery).not.toHaveBeenCalled();
  });

  it('wipes both opened secret versions after signature mismatch', async () => {
    const fixture = setup({});
    const base = request('{}', currentSecret);

    const response = await fixture.application.inject({
      ...base,
      headers: {
        ...base.headers,
        'x-pertexo-signature': `v1=${'0'.repeat(64)}`,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(fixture.openedSecrets).toHaveLength(2);
    for (const secret of fixture.openedSecrets)
      expect(Array.from(secret)).toEqual(Array.from(new Uint8Array(32)));
    expect(fixture.database.acceptVerifiedDelivery).not.toHaveBeenCalled();
  });

  it('maps replay mismatch and admission limits to stable corrective responses', async () => {
    const conflict = setup({
      reference: undefined,
      acceptanceError: new WebhookDeliveryReplayMismatchError(),
    });
    expect(
      (await conflict.application.inject(request('{}', currentSecret))).json<{
        code: string;
      }>().code,
    ).toBe('webhook.idempotency_conflict');
    const limited = setup({
      reference: undefined,
      acceptanceError: new WorkspaceRunQuotaExceededError(),
    });
    const response = await limited.application.inject(
      request('{}', currentSecret),
    );
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('5');

    const paused = setup({
      reference: undefined,
      acceptanceError: new WebhookWorkflowPausedError(),
    });
    const pausedResponse = await paused.application.inject(
      request('{}', currentSecret),
    );
    expect(pausedResponse.statusCode).toBe(423);
    expect(pausedResponse.json<{ code: string }>().code).toBe(
      'webhook.workflow_paused',
    );
  });

  it('fails closed for missing verification and malformed timestamp material', async () => {
    const missing = setup({});
    missing.database.resolveVerification.mockResolvedValueOnce(null);
    const missingResponse = await missing.application.inject(
      request('{}', currentSecret),
    );
    expect(missingResponse.statusCode).toBe(401);
    expect(missing.openSecret).not.toHaveBeenCalled();

    const malformed = setup({});
    const base = request('{}', currentSecret);
    const malformedResponse = await malformed.application.inject({
      ...base,
      headers: { ...base.headers, 'x-pertexo-timestamp': 'not-a-time' },
    });
    expect(malformedResponse.statusCode).toBe(401);
    expect(malformed.openSecret).not.toHaveBeenCalled();
  });

  it('rejects malformed idempotency headers before delivery admission', async () => {
    const { application, database } = setup({});
    const base = request('{}', currentSecret);
    const response = await application.inject({
      ...base,
      headers: { ...base.headers, 'idempotency-key': 'one,two' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('request.invalid');
    expect(database.acceptVerifiedDelivery).not.toHaveBeenCalled();
  });

  it.each([
    new WebhookDeliveryIneligibleError(),
    new WorkspaceRunAdmissionDeniedError(),
  ])(
    'conceals ineligible delivery admission as authentication failure',
    async (error) => {
      const { application } = setup({
        reference: undefined,
        acceptanceError: error,
      });
      const response = await application.inject(request('{}', currentSecret));
      expect(response.statusCode).toBe(401);
      expect(response.json<{ code: string }>().code).toBe(
        'webhook.authentication_failed',
      );
    },
  );
}
