import { readFileSync } from 'node:fs';

/** Generated env-file settings are supplemented by Compose's service environment. */
export function applicationEnvironments(base) {
  const file = process.env.PERTEXO_RESOLVED_CONFIG;
  const services = file ? JSON.parse(readFileSync(file, 'utf8')).services : {};
  const environments = Object.fromEntries(
    ['api', 'worker', 'migration'].map((name) => [
      name,
      { ...base, ...services[name]?.environment },
    ]),
  );
  return {
    ...environments,
    preparation: {
      ...base,
      ...services.api?.environment,
      ...services.worker?.environment,
    },
  };
}
