const repairs = {
  absolute_private_directory_required:
    'use an absolute private disk-backed directory',
  unix_socket_path_required:
    'use an absolute Unix socket path of at most 100 bytes',
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
