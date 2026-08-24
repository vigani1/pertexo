import {
  SpanStatusCode,
  type Meter,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { EmailSendNotificationExecutorError } from '@pertexo/integrations/server';
import { describe, expect, it, vi } from 'vitest';

import { createProductionEmailProviderTelemetry } from '../src/execution/email-provider-telemetry.js';

describe('email provider telemetry', () => {
  it('records only fixed-cardinality attributes and no email content', async () => {
    const add = vi.fn();
    const record = vi.fn();
    const setAttribute = vi.fn();
    const setStatus = vi.fn();
    const span = { end: vi.fn(), setAttribute, setStatus } as unknown as Span;
    const telemetry = createProductionEmailProviderTelemetry({
      meter: {
        createCounter: () => ({ add }),
        createHistogram: () => ({ record }),
      } as unknown as Meter,
      tracer: {
        startActiveSpan: (
          _name: string,
          work: (value: Span) => Promise<unknown>,
        ) => work(span),
      } as unknown as Tracer,
    });
    const output = { emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2' };
    await expect(
      telemetry.measure(() => Promise.resolve(output)),
    ).resolves.toBe(output);
    expect(add).toHaveBeenCalledWith(1, {
      provider_key: 'email',
      operation_key: 'send_notification',
      outcome: 'succeeded',
      possibly_dispatched: true,
    });
    expect(setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    const failure = new EmailSendNotificationExecutorError({
      kind: 'retry',
      errorKind: 'rate_limit',
      possiblyDispatched: true,
    });
    await expect(telemetry.measure(() => Promise.reject(failure))).rejects.toBe(
      failure,
    );
    const surface = JSON.stringify([
      add.mock.calls,
      record.mock.calls,
      setAttribute.mock.calls,
    ]);
    for (const forbidden of [
      'sender@example.com',
      'to@example.com',
      'subject',
      'text',
      're_secret',
    ])
      expect(surface).not.toContain(forbidden);
  });
});
