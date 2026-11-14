import { z } from 'zod';
import { NODE_JSON_LIMITS } from '../values/bounded-json.validation.js';
import { CodeRunnerSocketPathError } from './code.errors.js';

export const CODE_LIMITS = Object.freeze({
  sourceBytes: 65_536,
  logBytes: 65_536,
  logLines: 200,
  logLineCharacters: 2_048,
  messageCharacters: 2_048,
  taskBytes: 3 * NODE_JSON_LIMITS.bytes,
  resultBytes: 2 * NODE_JSON_LIMITS.bytes,
  defaultTimeoutSeconds: 5,
});

/** What an administrator may set for code steps. */
export const CODE_SETTING_BOUNDS = Object.freeze({
  // npm's longest package name.
  packageNameCharacters: 214,
  minimumMemoryMiB: 32,
  maximumMemoryMiB: 1_024,
  maximumSeconds: 300,
  maximumConcurrency: 16,
  packages: 32,
});

// Container sizing around the settings: the manager's base and per-slot memory,
// each task's memory beyond its heap, and process and CPU allowances.
const CODE_CONTAINER_SIZING = Object.freeze({
  managerBaseMiB: 192,
  managerPerSlotMiB: 16,
  taskOverheadMiB: 768,
  managerHeapBaseMiB: 64,
  managerHeapPerSlotMiB: 8,
  taskRssOverheadMiB: 64,
  maximumCpus: 2,
  basePids: 16,
  pidsPerSlot: 16,
});

// Unix socket paths are bounded by sockaddr_un; 100 bytes fits every platform.
const CODE_RUNNER_SOCKET_PATH_BYTES = 100;
export const CODE_ALLOWED_BUILTINS = Object.freeze([
  'assert',
  'buffer',
  'crypto',
  'events',
  'path',
  'querystring',
  'string_decoder',
  'url',
  'util',
  'zlib',
]);
export const CODE_DEFAULT_PACKAGES = Object.freeze(['lodash', 'dayjs']);
export const codeLanguageSchema = z.enum(['javascript', 'python']);
export type CodeLanguage = z.output<typeof codeLanguageSchema>;
export const CODE_PYTHON_MODULES = Object.freeze([
  'json',
  'math',
  'statistics',
  'datetime',
  // datetime's C methods import these through the caller's import hook.
  'time',
  '_strptime',
  'zoneinfo',
  're',
  'decimal',
  'fractions',
  'itertools',
  'functools',
  'collections',
  'string',
  'textwrap',
  'hashlib',
  'hmac',
  'base64',
  'uuid',
  'random',
  'urllib.parse',
  'html',
  'csv',
  'io',
]);
const packageName = z
  .string()
  .max(CODE_SETTING_BOUNDS.packageNameCharacters)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u);
export const codeSettingsSchema = z
  .object({
    enabled: z.boolean(),
    memoryMiB: z
      .number()
      .int()
      .min(CODE_SETTING_BOUNDS.minimumMemoryMiB)
      .max(CODE_SETTING_BOUNDS.maximumMemoryMiB),
    maximumSeconds: z
      .number()
      .int()
      .min(1)
      .max(CODE_SETTING_BOUNDS.maximumSeconds),
    concurrency: z
      .number()
      .int()
      .min(1)
      .max(CODE_SETTING_BOUNDS.maximumConcurrency),
    extraPackages: z
      .array(packageName)
      .max(CODE_SETTING_BOUNDS.packages)
      .readonly(),
    pythonPackages: z
      .array(
        z
          .string()
          .max(CODE_SETTING_BOUNDS.packageNameCharacters)
          .regex(/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*$/u),
      )
      .max(CODE_SETTING_BOUNDS.packages)
      .readonly()
      .default([]),
  })
  .strict();
export type CodeSettings = Readonly<z.output<typeof codeSettingsSchema>>;
export const DEFAULT_CODE_SETTINGS: CodeSettings = Object.freeze({
  enabled: true,
  memoryMiB: 128,
  maximumSeconds: 30,
  concurrency: 2,
  extraPackages: Object.freeze([]),
  pythonPackages: Object.freeze([]),
});

const settingShape = codeSettingsSchema.shape;
const environmentNumber = (setting: z.ZodNumber, fallback: number) =>
  z.coerce.number().pipe(setting).default(fallback);
const environmentPackages = <T extends z.ZodType>(setting: T) =>
  z
    .string()
    .default('[]')
    .transform((text, context): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        context.addIssue({
          code: 'custom',
          message: 'must be a JSON array of package names',
        });
        return z.NEVER;
      }
    })
    .pipe(setting);
const codeEnvironmentSchema = z.object({
  CODE_STEPS_ENABLED: z
    .enum(['true', 'false'])
    .default(DEFAULT_CODE_SETTINGS.enabled ? 'true' : 'false'),
  CODE_RUNNER_MEMORY_MB: environmentNumber(
    settingShape.memoryMiB,
    DEFAULT_CODE_SETTINGS.memoryMiB,
  ),
  CODE_RUNNER_MAX_SECONDS: environmentNumber(
    settingShape.maximumSeconds,
    DEFAULT_CODE_SETTINGS.maximumSeconds,
  ),
  CODE_RUNNER_CONCURRENCY: environmentNumber(
    settingShape.concurrency,
    DEFAULT_CODE_SETTINGS.concurrency,
  ),
  CODE_RUNNER_PACKAGES: environmentPackages(settingShape.extraPackages),
  CODE_RUNNER_PYTHON_PACKAGES: environmentPackages(settingShape.pythonPackages),
});

/** Parse administrator input at each process's configuration boundary. */
export function parseCodeSettings(
  environment: Readonly<Record<string, unknown>>,
): CodeSettings {
  const raw = codeEnvironmentSchema.parse(environment);
  return {
    enabled: raw.CODE_STEPS_ENABLED === 'true',
    memoryMiB: raw.CODE_RUNNER_MEMORY_MB,
    maximumSeconds: raw.CODE_RUNNER_MAX_SECONDS,
    concurrency: raw.CODE_RUNNER_CONCURRENCY,
    extraPackages: raw.CODE_RUNNER_PACKAGES,
    pythonPackages: raw.CODE_RUNNER_PYTHON_PACKAGES,
  };
}

export function codeContainerLimits(settings: CodeSettings) {
  const sizing = CODE_CONTAINER_SIZING;
  const managerMiB =
    sizing.managerBaseMiB + settings.concurrency * sizing.managerPerSlotMiB;
  const taskMiB = settings.memoryMiB + sizing.taskOverheadMiB;
  return Object.freeze({
    memoryMiB: managerMiB + (settings.concurrency + 1) * taskMiB,
    managerHeapMiB:
      sizing.managerHeapBaseMiB +
      settings.concurrency * sizing.managerHeapPerSlotMiB,
    taskRssMiB: settings.memoryMiB + sizing.taskRssOverheadMiB,
    cpus: Math.min(settings.concurrency + 1, sizing.maximumCpus),
    pids: sizing.basePids + settings.concurrency * sizing.pidsPerSlot,
  });
}

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
