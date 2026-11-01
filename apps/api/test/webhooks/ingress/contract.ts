import type { WebhookTriggerDatabase } from '@pertexo/core/testing';

export type AcceptInput = Parameters<
  WebhookTriggerDatabase['acceptVerifiedDelivery']
>[0];

export type Scenario = Readonly<{
  name: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  acceptanceError?: Error;
  status: number;
  fact: Readonly<Record<string, string>>;
}>;
