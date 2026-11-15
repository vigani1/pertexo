import {
  parseCodeSettings,
  codeRunnerSocketPath,
  type CodeSettings,
} from '@pertexo/node-sdk';
import { RunnerConfigurationError } from './runner-configuration.errors.js';

/** The group the hardened manager runs as and shares its socket with. */
export const RUNNER_MANAGER_GROUP_ID = 10_001;

/** File modes: private to the manager, or shared with its group when hardened. */
export const RUNNER_FILE_MODES = Object.freeze({
  privateDirectory: 0o700,
  sharedDirectory: 0o770,
  privateFile: 0o600,
  sharedFile: 0o660,
});

/** The search path a hardened task process gets; process mode inherits the host's. */
export const HARDENED_TASK_PATH = '/usr/local/bin:/usr/bin:/bin';

export type RunnerConfig = Readonly<{
  settings: CodeSettings;
  mode: 'hardened' | 'process';
  socketPath: string;
  /** The PATH a task process starts with. */
  taskPath: string;
  /** The names the manager inherited, which isolation checks for shared credentials. */
  inheritedVariableNames: readonly string[];
}>;
export function parseRunnerConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RunnerConfig {
  const deployed =
    environment.NODE_ENV === 'production' || environment.NODE_ENV === 'staging';
  const mode =
    environment.CODE_RUNNER_MODE ?? (deployed ? 'hardened' : 'process');
  const invalidRunnerMode =
    (mode !== 'hardened' && mode !== 'process') ||
    (deployed && mode !== 'hardened');
  if (invalidRunnerMode)
    throw new RunnerConfigurationError(
      'Deployed Code runners require hardened mode',
    );
  const socketPath = codeRunnerSocketPath({
    configured: environment.CODE_RUNNER_SOCKET,
    hardened: mode === 'hardened',
    uid: process.getuid?.() ?? 'local',
  });
  return Object.freeze({
    settings: parseCodeSettings(environment),
    mode,
    socketPath,
    taskPath:
      mode === 'hardened'
        ? HARDENED_TASK_PATH
        : (environment.PATH ?? HARDENED_TASK_PATH),
    inheritedVariableNames: Object.freeze(Object.keys(environment)),
  });
}
