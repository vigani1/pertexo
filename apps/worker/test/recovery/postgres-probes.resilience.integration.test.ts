import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { beforeAll, expect, it } from 'vitest';

import {
  developmentService,
  productionService,
  type ComposeServiceSettings,
} from '../support/recovery/compose-config.js';
import {
  describeFaults,
  SCENARIO_LIMIT_MS,
} from '../support/recovery/environment.js';
import { delay } from '../support/recovery/facts.js';

const execFileAsync = promisify(execFile);
const READY_LIMIT_MS = 60_000;
const CRASH_MARKER = 'terminating any other active server processes';

const docker = async (...arguments_: readonly string[]): Promise<string> => {
  const { stderr, stdout } = await execFileAsync('docker', [...arguments_], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return `${stdout}${stderr}`;
};

/**
 * A probe Docker abandons is reparented to PID 1 and later exits 2. As PID 1 the
 * postmaster treats that as a crashed child and restarts every connection.
 */
async function orphanOutcome(
  settings: ComposeServiceSettings,
): Promise<'crash-restart' | 'stays-up'> {
  const name = `pertexo-probe-${randomUUID().slice(0, 8)}`;
  await docker(
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    ...(settings.init ? ['--init'] : []),
    '--env',
    'POSTGRES_PASSWORD=fixture',
    settings.image,
  );
  try {
    const deadline = Date.now() + READY_LIMIT_MS;
    for (;;) {
      const ready = await docker(
        'exec',
        name,
        'pg_isready',
        '-U',
        'postgres',
        '-h',
        '127.0.0.1',
      ).catch(() => '');
      if (ready.includes('accepting connections')) break;
      if (Date.now() > deadline) throw new Error('Postgres never became ready');
      await delay(500);
    }
    await docker(
      'exec',
      name,
      'sh',
      '-c',
      '(sh -c "sleep 1; exit 2" &) ; exit 0',
    );
    await delay(4_000);
    const logs = await docker('logs', name);
    return logs.includes(CRASH_MARKER) ? 'crash-restart' : 'stays-up';
  } finally {
    await docker('rm', '--force', name).catch(() => '');
  }
}

/** `pg_isready`'s own limit, which must end before Docker abandons the probe. */
function probeLimitMs(settings: ComposeServiceSettings): number | undefined {
  const seconds = /(?:^|\s)-t\s*(\d+)/u.exec(settings.healthcheckCommand)?.[1];
  return seconds === undefined ? undefined : Number(seconds) * 1_000;
}

describeFaults('Postgres health probes (dm-01)', () => {
  let production: ComposeServiceSettings;
  let development: ComposeServiceSettings;
  let productionOutcome: string;
  let developmentOutcome: string;

  beforeAll(async () => {
    production = await productionService('postgres');
    development = await developmentService('postgres');
    productionOutcome = await orphanOutcome(production);
    developmentOutcome = await orphanOutcome(development);
  }, SCENARIO_LIMIT_MS);

  // dm-01: 7 crash-restarts in 62 s from an abandoned production probe.
  it.fails('survives an orphan exiting non-zero, in production compose', () => {
    expect(productionOutcome).toBe('stays-up');
  });

  // dm-01: the same orphan crash-restarts development Postgres.
  it.fails(
    'survives an orphan exiting non-zero, in development compose',
    () => {
      expect(developmentOutcome).toBe('stays-up');
    },
  );

  // dm-01: pg_isready's default 3 s races Docker's production 3 s timeout.
  it.fails('ends its production probe before Docker abandons it', () => {
    expect(probeLimitMs(production)).toBeLessThan(
      production.healthcheckTimeoutMs,
    );
  });

  // dm-01: both compose files take the same fix.
  it.fails('ends its development probe before Docker abandons it', () => {
    expect(probeLimitMs(development)).toBeLessThan(
      development.healthcheckTimeoutMs,
    );
  });
});
