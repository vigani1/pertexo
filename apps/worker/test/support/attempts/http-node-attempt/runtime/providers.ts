import {
  SecureHttpClient,
  type SecureHttpTransportRequest,
} from '@pertexo/integrations/server';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';

import type { Attributes, Meter, Span, Tracer } from '@opentelemetry/api';

import type { NodeExecutionRegistry } from '@pertexo/workflow-engine';

import { createHttpProviderTelemetry } from '../../../../../src/providers/telemetry.js';

import type { HttpNodeAttemptProofRuntimeOptions } from './contract.js';

export function createHttpProofProviders(
  options: HttpNodeAttemptProofRuntimeOptions,
) {
  const transportRequests: SecureHttpTransportRequest[] = [];
  const slackRequests: {
    botToken: string;
    channelId: string;
    text: string;
  }[] = [];
  const emailRequests: {
    apiKey: string;
    fromEmail: string;
    toEmail: string;
    subject: string;
    text: string;
    idempotencyKey: string;
  }[] = [];
  const telemetry: {
    kind: 'count' | 'duration' | 'span';
    name: string;
    attributes?: Attributes;
  }[] = [];
  const meter = {
    createCounter: (name: string) => ({
      add: (_value: number, attributes?: Attributes) =>
        telemetry.push({
          kind: 'count',
          name,
          ...(attributes === undefined ? {} : { attributes }),
        }),
    }),
    createHistogram: (name: string) => ({
      record: (_value: number, attributes?: Attributes) =>
        telemetry.push({
          kind: 'duration',
          name,
          ...(attributes === undefined ? {} : { attributes }),
        }),
    }),
  } as unknown as Meter;
  const tracer = {
    startActiveSpan: async <T>(
      name: string,
      work: (span: Span) => Promise<T>,
    ): Promise<T> => {
      const attributes: Attributes = {};
      const span = {
        setAttributes: (values: Attributes) => {
          Object.assign(attributes, values);
          return span;
        },
        setStatus: () => span,
        end: () => telemetry.push({ kind: 'span', name, attributes }),
      } as unknown as Span;
      return work(span);
    },
  } as unknown as Tracer;
  const httpClient = new SecureHttpClient(
    {
      resolve: () =>
        Promise.resolve([{ address: '8.8.8.8', family: 4 as const }]),
    },
    {
      dispatch: async (request) => {
        transportRequests.push(request);
        if (options.dispatchHttp !== undefined)
          return options.dispatchHttp(request);
        return {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
          body: (async function* () {
            await Promise.resolve();
            yield new Uint8Array(35_000).fill(7);
            yield new Uint8Array(35_000).fill(9);
          })(),
          close: () => undefined,
        };
      },
    },
  );
  const registry = createPlatformNodeRegistry({
    httpRequest: { httpClient },
    httpRequestTelemetry: createHttpProviderTelemetry({
      meter,
      tracer,
    }),
    slackSendMessage: {
      client: {
        sendMessage: async (input) => {
          await input.beforeDispatch();
          slackRequests.push({
            botToken: input.botToken,
            channelId: input.channelId,
            text: input.text,
          });
          if (options.sendSlackMessage !== undefined)
            return options.sendSlackMessage({
              ...input,
              beforeDispatch: () => Promise.resolve(),
            });
          return {
            kind: 'succeeded',
            channelId: input.channelId,
            messageTs: '1724412345.000100',
          };
        },
      },
    },
    emailSendNotification: {
      client: {
        sendNotification: async (input) => {
          await input.beforeDispatch();
          emailRequests.push({
            apiKey: input.apiKey,
            fromEmail: input.fromEmail,
            toEmail: input.toEmail,
            subject: input.subject,
            text: input.text,
            idempotencyKey: input.idempotencyKey,
          });
          if (options.sendEmailNotification !== undefined)
            return options.sendEmailNotification({
              ...input,
              beforeDispatch: () => Promise.resolve(),
            });
          const scripted =
            options.emailResponseScript?.[emailRequests.length - 1];
          if (scripted !== undefined) return scripted;
          if (
            options.emailResponseScript !== undefined &&
            emailRequests.length > options.emailResponseScript.length
          )
            throw new Error('Email response script was exhausted');
          return {
            kind: 'succeeded',
            emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2',
          };
        },
      },
    },
  });
  const executionRegistry: NodeExecutionRegistry =
    options.beforeRegistryExecute === undefined
      ? registry
      : Object.freeze({
          dispatchMode: registry.dispatchMode,
          execute: async (
            request: Parameters<NodeExecutionRegistry['execute']>[0],
          ) => {
            await options.beforeRegistryExecute?.(request);
            return registry.execute(request);
          },
        });

  return {
    transportRequests,
    slackRequests,
    emailRequests,
    telemetry,
    executionRegistry,
  };
}
