import { KMSClient } from '@aws-sdk/client-kms';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export const KMS_OPERATION_BUDGET = Object.freeze({
  connectionTimeoutMs: 5_000,
  requestTimeoutMs: 10_000,
  maxAttempts: 2,
});

export function createBoundedKmsClient(
  config: Readonly<{
    region: string;
  endpoint?: string | undefined;
  }>,
): KMSClient {
  return new KMSClient({
    region: config.region,
    maxAttempts: KMS_OPERATION_BUDGET.maxAttempts,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: KMS_OPERATION_BUDGET.connectionTimeoutMs,
      requestTimeout: KMS_OPERATION_BUDGET.requestTimeoutMs,
      socketTimeout: KMS_OPERATION_BUDGET.requestTimeoutMs,
      throwOnRequestTimeout: true,
    }),
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
  });
}
