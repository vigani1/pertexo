import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ZodError } from 'zod';
import { parseApiConfig } from '../../../apps/api/dist/platform/config/api-config.js';
import { ApiConfigurationError } from '../../../apps/api/dist/platform/config/api-configuration.errors.js';
import { parseWorkerConfig } from '../../../apps/worker/dist/config/worker.js';
import { parseMigrationConfig } from '../../../packages/database/dist/config.js';
import {
  StartupSettingError,
  describeStartupSettingError,
} from '../../../packages/observability/dist/startup.js';

/** Uses the application boundaries, including conditional mail, OAuth and encryption rules. */
export function validateApplicationConfiguration(environment) {
  const values = {
    ...environment,
    WORKER_INSTANCE_ID: 'deployment-validation',
  };
  const results = [];
  const failures = [];
  for (const parse of [
    parseApiConfig,
    parseWorkerConfig,
    parseMigrationConfig,
  ]) {
    try {
      results.push(parse(values));
    } catch (error) {
      failures.push(...configurationGuidance(error));
    }
  }
  if (failures.length) {
    for (const line of new Set(failures)) process.stderr.write(`${line}\n`);
    process.exit(1);
  }
  return { apiConfig: results[0], workerConfig: results[1] };
}

function configurationGuidance(error) {
  if (error instanceof ApiConfigurationError)
    return [error.message + '; check .env.production.'];
  if (error instanceof StartupSettingError)
    return [`${describeStartupSettingError(error)}; check .env.production.`];
  if (error instanceof ZodError)
    return error.issues.map(
      (issue) =>
        `${issue.path.join('.') || 'Application settings'}: set a valid value in .env.production.`,
    );
  if (error instanceof Error && error.cause)
    return configurationGuidance(error.cause);
  return [
    'Application settings: configuration could not be validated; rebuild the operator checkout and check .env.production.',
  ];
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const file = process.argv[2];
  if (!file) throw new Error('usage: preflight.mjs <settings-file>');
  validateApplicationConfiguration({
    ...parseEnv(readFileSync(file, 'utf8')),
    ...process.env,
  });
}
