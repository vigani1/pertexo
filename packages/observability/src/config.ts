import './server-only.js';

import { z } from 'zod';

const httpEndpointSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'http:' || protocol === 'https:';
}, 'must use http or https');

const observabilityConfigSchema = z
  .object({
    serviceName: z.string().trim().min(1),
    serviceVersion: z.string().trim().min(1),
    environment: z
      .enum(['development', 'test', 'staging', 'production'])
      .default('development'),
    logLevel: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    otlpHttpEndpoint: httpEndpointSchema.optional(),
    otlpHeaders: z.record(z.string().trim().min(1), z.string()).default({}),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.otlpHttpEndpoint === undefined &&
      Object.keys(value.otlpHeaders).length > 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'otlpHeaders requires otlpHttpEndpoint',
        path: ['otlpHeaders'],
      });
    }
  });

export type ObservabilityConfigInput = z.input<
  typeof observabilityConfigSchema
>;

export interface ObservabilityConfig {
  readonly environment: 'development' | 'test' | 'staging' | 'production';
  readonly logLevel:
    'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  readonly otlpHeaders: Readonly<Record<string, string>>;
  readonly otlpHttpEndpoint?: string;
  readonly serviceName: string;
  readonly serviceVersion: string;
}

export function parseObservabilityConfig(
  input: ObservabilityConfigInput,
): ObservabilityConfig {
  const parsed = observabilityConfigSchema.parse(input);
  const otlpHeaders = Object.freeze({ ...parsed.otlpHeaders });

  return Object.freeze({
    environment: parsed.environment,
    logLevel: parsed.logLevel,
    otlpHeaders,
    ...(parsed.otlpHttpEndpoint === undefined
      ? {}
      : { otlpHttpEndpoint: parsed.otlpHttpEndpoint }),
    serviceName: parsed.serviceName,
    serviceVersion: parsed.serviceVersion,
  });
}
