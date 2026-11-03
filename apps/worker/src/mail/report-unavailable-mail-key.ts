import type { StructuredLogger } from '@pertexo/observability';

export function reportUnavailableMailKey(
  logger: Pick<StructuredLogger, 'warn'>,
  version: string,
): void {
  logger.warn('system_mail.key_unavailable', {
    keyVersion: version,
    instruction:
      'Restore this version in AUTH_MAIL_PREVIOUS_KEYS and restart the worker. Affected mail waits encrypted; workflows continue.',
  });
}
