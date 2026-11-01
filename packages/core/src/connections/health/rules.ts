import {
  CONNECTION_AUTH_TYPE,
  CONNECTION_STATUS,
  type ConnectionAuthType,
  type ConnectionRecord,
  type ConnectionStatus,
} from '../contract.js';

/** A client alone isn't connected: consent gives it its first token. */
export function healthOfNewSecret(
  authType: ConnectionAuthType,
): Readonly<{ status: ConnectionStatus; lastErrorCode: string | null }> {
  return authType === CONNECTION_AUTH_TYPE.oauth2
    ? {
        status: CONNECTION_STATUS.reauthorizationRequired,
        lastErrorCode: 'connection.oauth2_not_authorized',
      }
    : { status: CONNECTION_STATUS.active, lastErrorCode: null };
}

/** A test only speaks for a secret that is still the current one. */
export function isStaleTestObservation(
  current: Pick<ConnectionRecord, 'status' | 'currentSecretVersionId'>,
  tested: Readonly<{
    secretVersionId: string;
    healthRevision: string | undefined;
  }>,
): boolean {
  return (
    current.status === CONNECTION_STATUS.revoked ||
    current.currentSecretVersionId !== tested.secretVersionId ||
    tested.healthRevision === undefined
  );
}

/**
 * A run only speaks for the exact secret and health revision it dispatched
 * with, and only Slack bot tokens report health from runs.
 */
export function isStaleRunObservation(
  connection: Readonly<{
    status: string;
    current_secret_version_id: string;
    health_revision: string;
    provider_key: string;
    auth_type: string;
  }>,
  dispatch: Readonly<{ secret_version_id: string; health_revision: string }>,
): boolean {
  return (
    connection.status === CONNECTION_STATUS.revoked ||
    connection.current_secret_version_id !== dispatch.secret_version_id ||
    connection.health_revision !== dispatch.health_revision ||
    connection.provider_key !== 'slack' ||
    connection.auth_type !== CONNECTION_AUTH_TYPE.slackBotToken
  );
}
