import { z } from 'zod';
import { NODE_JSON_LIMITS } from '../values/bounds.js';

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
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u);
export const codeSettingsSchema = z
  .object({
    enabled: z.boolean(),
    memoryMiB: z.number().int().min(32).max(1_024),
    maximumSeconds: z.number().int().min(1).max(300),
    concurrency: z.number().int().min(1).max(16),
    extraPackages: z.array(packageName).max(32).readonly(),
    pythonPackages: z
      .array(
        z
          .string()
          .max(214)
          .regex(/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*$/u),
      )
      .max(32)
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
  const managerMiB = 192 + settings.concurrency * 16;
  const taskMiB = settings.memoryMiB + 768;
  return Object.freeze({
    memoryMiB: managerMiB + (settings.concurrency + 1) * taskMiB,
    managerHeapMiB: 64 + settings.concurrency * 8,
    taskRssMiB: settings.memoryMiB + 64,
    cpus: Math.min(settings.concurrency + 1, 2),
    pids: 16 + settings.concurrency * 16,
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
    new TextEncoder().encode(path).byteLength > 100
  )
    throw new Error(
      'CODE_RUNNER_SOCKET must be an absolute Unix socket path up to 100 bytes',
    );
  return path;
}
