import { z } from 'zod';
import { NODE_JSON_LIMITS } from '../values/bounded-json.validation.js';

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
