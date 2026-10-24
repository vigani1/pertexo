import { CONNECTION_STATUS, CONNECTION_EVENT_TYPE } from '../contract.js';

import type { ConnectionRecord, ConnectionTestResult } from '../contract.js';

export function classifyConnectionTestCompletion(
  currentStatus: ConnectionRecord['status'],
  outcome: ConnectionTestResult['outcome'],
  secretVersionId: string,
  { currentSecretWasTested }: Readonly<{ currentSecretWasTested: boolean }>,
) {
  const sharedMetadata = { secretVersionId, currentSecretWasTested };
  if (outcome.ok)
    return Object.freeze({
      eventType: CONNECTION_EVENT_TYPE.testSucceeded,
      healthUpdateAllowed:
        currentStatus !== CONNECTION_STATUS.revoked && currentSecretWasTested,
      nextStatus: CONNECTION_STATUS.active,
      lastErrorCode: null,
      eventMetadata: Object.freeze({
        ...sharedMetadata,
        httpStatus: outcome.httpStatus,
      }),
    });
  return Object.freeze({
    eventType: outcome.reauthorizationRequired
      ? CONNECTION_EVENT_TYPE.reauthorizationRequired
      : CONNECTION_EVENT_TYPE.testFailed,
    nextStatus: outcome.reauthorizationRequired
      ? CONNECTION_STATUS.reauthorizationRequired
      : currentStatus,
    lastErrorCode: outcome.errorCode,
    healthUpdateAllowed:
      currentStatus !== CONNECTION_STATUS.revoked && currentSecretWasTested,
    eventMetadata: Object.freeze({
      ...sharedMetadata,
      errorCode: outcome.errorCode,
      httpStatus: outcome.httpStatus,
    }),
  });
}
