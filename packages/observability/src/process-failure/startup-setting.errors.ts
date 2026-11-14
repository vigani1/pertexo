import type { z } from 'zod';

/**
 * Secrets' key ring limits, restated because observability loads before
 * secrets and can't import it. The worker's key-ring-repair-bounds test holds
 * each one to the limit secrets enforces.
 */
export const KEY_RING_REPAIR_BOUNDS = Object.freeze({
  keyBytes: 32,
  maxPreviousKeys: 8,
  maxVersionLength: 64,
});

// The apps' own setting limits, as their configs enforce them.
const SETTING_BOUNDS = Object.freeze({
  maxPort: 65_535,
  timeoutMs: { min: 100, max: 30_000 },
  pollIntervalMs: { min: 100, max: 60_000 },
  maxWorkerIdLength: 118,
  maxApiKeyLength: 512,
  maxOperatorRefLength: 128,
  maxOperatorReasonLength: 512,
  maxSocketPathBytes: 100,
});

const { keyBytes, maxPreviousKeys, maxVersionLength } = KEY_RING_REPAIR_BOUNDS;
const repairs = {
  node_environment_required:
    'set NODE_ENV to development, test, staging or production',
  smtp_hostname_required: 'use a valid SMTP hostname or IP address',
  smtp_port_required: `use an SMTP port from 1 to ${String(SETTING_BOUNDS.maxPort)}`,
  smtp_tls_required:
    'use starttls or implicit SMTP TLS; plaintext is allowed only on development loopback',
  smtp_credentials_required:
    'configure both SMTP username and password together, within their length limits',

  email_required: 'use a valid email address',
  key_version_required: `use a key version starting with letters or digits, followed by letters, digits, dots, underscores, colons or hyphens (at most ${String(maxVersionLength)} characters)`,
  application_key_required: `provide a base64 encoded ${String(keyBytes)}-byte application key`,
  previous_keys_required: `provide a JSON array of at most ${String(maxPreviousKeys)} unique historical key versions and their base64 encoded ${String(keyBytes)}-byte keys; keep versions distinct from the current version`,
  timeout_required: `use an integer timeout from ${String(SETTING_BOUNDS.timeoutMs.min)} to ${String(SETTING_BOUNDS.timeoutMs.max)} milliseconds`,
  poll_interval_required: `use an integer polling interval from ${String(SETTING_BOUNDS.pollIntervalMs.min)} to ${String(SETTING_BOUNDS.pollIntervalMs.max)} milliseconds`,
  worker_id_required: `use a worker identity of at most ${String(SETTING_BOUNDS.maxWorkerIdLength)} letters, digits, dots, underscores, colons or hyphens`,
  api_key_required: `provide the delivery API key (1 to ${String(SETTING_BOUNDS.maxApiKeyLength)} characters)`,
  mail_transport_required:
    'set SYSTEM_MAIL_TRANSPORT to resend or smtp and configure its delivery credentials',
  database_url_required:
    'provide an application-role PostgreSQL connection URL',
  operator_ref_required: `provide a nonempty operator identity (at most ${String(SETTING_BOUNDS.maxOperatorRefLength)} characters)`,
  operator_reason_required: `provide a recovery reason from 1 to ${String(SETTING_BOUNDS.maxOperatorReasonLength)} characters`,
  recovery_arguments_required:
    'use --email followed by one valid email address',
  durable_mail_required:
    'set AUTH_MAIL_MODE=durable and configure its sender and encryption keys for deployed recovery',
  local_mail_required:
    'use local mail only in development and remove AUTH_MAIL sender and encryption settings, or set AUTH_MAIL_MODE=durable',

  absolute_private_directory_required:
    'use an absolute private disk-backed directory',
  unix_socket_path_required: `use an absolute Unix socket path of at most ${String(SETTING_BOUNDS.maxSocketPathBytes)} bytes`,
  https_required: 'use an HTTPS endpoint',
  http_origin_required:
    'use an HTTP(S) origin without credentials, a path, query or fragment',
  required_when_deployed:
    'configure this required setting for deployed workers',
} as const;

type StartupSettingReason = keyof typeof repairs;

/** Only an owned configuration refusal may supply a setting and closed repair code. */
export class StartupSettingError extends Error {
  override readonly name = 'StartupSettingError';
  constructor(
    readonly setting: string,
    readonly reason: StartupSettingReason,
    options?: ErrorOptions,
  ) {
    super('A startup setting is invalid', options);
  }
}

export function describeStartupSettingError(
  error: StartupSettingError,
): string {
  if (
    !/^[A-Z][A-Z0-9_]{0,127}$/u.test(error.setting) ||
    !Object.hasOwn(repairs, error.reason)
  )
    return '[Redacted]';
  return `${error.setting}: ${repairs[error.reason]}`;
}

/** Translate admission failures once, without allowing rejected values into diagnostics. */
export function parseStartupSettings<T>(
  schema: z.ZodType<T>,
  environment: Readonly<Record<string, string | undefined>>,
  remedies: Readonly<Record<string, StartupSettingReason>>,
): T {
  const parsed = schema.safeParse(environment);
  if (parsed.success) return parsed.data;
  const setting = parsed.error.issues[0]?.path[0];
  if (typeof setting === 'string' && Object.hasOwn(remedies, setting)) {
    const remedy = remedies[setting];
    if (remedy !== undefined) throw new StartupSettingError(setting, remedy);
  }
  throw parsed.error;
}
