import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { WebhookPreflightController } from '../../../src/webhooks/authentication/preflight.controller.js';
import { WEBHOOK_PREFLIGHT } from '../../../src/webhooks/tokens.js';
import { RateLimitModule } from '../../../src/platform/rate-limit/module.js';
import type { RateLimitConsumer } from '../../../src/platform/rate-limit/admission.js';

import type { WebhookTriggerDatabase } from '@pertexo/database/testing';

import type { WebhookTriggerEnvelopeEncryption } from '@pertexo/integrations/server';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, vi } from 'vitest';
import {
  registerWebhookIngress,
  createWebhookPreflight,
} from '../../../src/webhooks/ingress/register.js';
import type { WebhookIngressTelemetry } from '../../../src/webhooks/ingress/telemetry.js';
import { currentSecret, previousSecret, verification } from './environment.js';

export function createIngressFixture() {
  const applications: FastifyInstance[] = [];

  const nestApplications: INestApplication[] = [];

  beforeEach(() => {
    currentSecret.fill(4);
    previousSecret.fill(5);
  });

  afterEach(async () => {
    await Promise.all(
      nestApplications.splice(0).map((application) => application.close()),
    );
    await Promise.all(
      applications.splice(0).map((application) => application.close()),
    );
  });

  async function setupPreflight(reference = verification) {
    const fixture = setup({ reference: reference });
    const consume = vi
      .fn<RateLimitConsumer['consume']>()
      .mockResolvedValue({ allowed: true });
    const testing = await Test.createTestingModule({
      imports: [RateLimitModule.register('redis://unused', { consume })],
      controllers: [WebhookPreflightController],
      providers: [
        {
          provide: WEBHOOK_PREFLIGHT,
          useValue: createWebhookPreflight(fixture.dependencies),
        },
      ],
    }).compile();
    const application = testing.createNestApplication(
      new FastifyAdapter(fixture.application),
    );
    nestApplications.push(application);
    applications.splice(applications.indexOf(fixture.application), 1);
    await application.init();
    return { ...fixture, consume };
  }

  function setup({
    reference = verification,
    acceptanceError,
    acceptance = {
      runId: '99999999-9999-4999-8999-999999999999',
      replayed: false,
    },
    includeTraceparent = true,
    telemetryOverrides = {},
  }: Readonly<{
    reference?: typeof verification | undefined;
    acceptanceError?: Error | undefined;
    acceptance?: { runId: string; replayed: boolean } | undefined;
    includeTraceparent?: boolean | undefined;
    telemetryOverrides?: Partial<WebhookIngressTelemetry> | undefined;
  }> = {}) {
    const database = {
      readResponse: vi
        .fn<WebhookTriggerDatabase['readResponse']>()
        .mockResolvedValue({ state: 'pending' }),
      resolveVerification: vi.fn().mockResolvedValue(reference),
      consumeIngressLimit: vi.fn().mockResolvedValue(undefined),
      acceptVerifiedDelivery: acceptanceError
        ? vi.fn().mockRejectedValue(acceptanceError)
        : vi.fn().mockResolvedValue(acceptance),
      recordRejectedDelivery: vi.fn().mockResolvedValue(undefined),
    };
    const openedSecrets: Uint8Array[] = [];
    const openSecret = vi
      .fn()
      .mockImplementation(
        (_value: unknown, context: { secretVersionId: string }) => {
          const secret = new Uint8Array(32).fill(
            context.secretVersionId === verification.currentSecret.id ? 4 : 5,
          );
          openedSecrets.push(secret);
          return Promise.resolve(secret);
        },
      );
    const encryption = {
      open: openSecret,
    } as unknown as WebhookTriggerEnvelopeEncryption;
    const delivery = vi.fn();
    const deduplication = vi.fn();
    const health = vi.fn();
    const trace = vi.fn();
    const telemetry: WebhookIngressTelemetry = {
      delivery,
      deduplication,
      health,
      traceparent: () =>
        includeTraceparent
          ? '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01'
          : undefined,
      trace: async <T>(
        _traceparent: string | undefined,
        work: () => Promise<T>,
      ) => {
        trace();
        return work();
      },
      ...telemetryOverrides,
    };
    const application = Fastify();
    applications.push(application);
    const dependencies = {
      database: database as unknown as WebhookTriggerDatabase,
      encryption,
      checkpointFactory: () => ({ checkpoint: {} }),
      telemetry,
    };
    registerWebhookIngress(application, dependencies);
    return {
      dependencies,
      application,
      database,
      delivery,
      deduplication,
      health,
      openSecret,
      openedSecrets,
      trace,
    };
  }
  return { setup, setupPreflight, applications };
}
