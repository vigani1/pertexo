import { CodeRunnerSocketPathError } from './code.errors.js';

// Unix socket paths are bounded by sockaddr_un; 100 bytes fits every platform.
const CODE_RUNNER_SOCKET_PATH_BYTES = 100;
/** Shared Unix socket configuration; no process or credential access. */
export function codeRunnerSocketPath({
  configured,
  hardened,
  uid,
}: Readonly<{
  configured: string | undefined;
  hardened: boolean;
  uid: number | string;
}>): string {
  const path =
    configured ??
    (hardened
      ? '/run/pertexo-code/runner.sock'
      : `/tmp/pertexo-code-${String(uid)}/runner.sock`);
  if (
    !path.startsWith('/') ||
    path.includes('\0') ||
    new TextEncoder().encode(path).byteLength > CODE_RUNNER_SOCKET_PATH_BYTES
  )
    throw new CodeRunnerSocketPathError(
      `CODE_RUNNER_SOCKET must be an absolute Unix socket path up to ${String(CODE_RUNNER_SOCKET_PATH_BYTES)} bytes`,
    );
  return path;
}
