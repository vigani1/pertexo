import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const OPERATION_MARKER = 'PERTEXO_Q11_OPERATION_V2=';
const directory = process.env.PERTEXO_Q11_OVERLAP_DIRECTORY;
const participant = process.env.PERTEXO_Q11_OVERLAP_PARTICIPANT;

if (directory === undefined || participant === undefined)
  throw new Error('Overlap fixture requires its directory and participant');

await writeFile(path.join(directory, `${participant}.ready`), '', {
  flag: 'wx',
});
for (;;) {
  try {
    await access(path.join(directory, 'release'));
    break;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await delay(5);
  }
}

const startedAtUnixMs = performance.timeOrigin + performance.now();
await delay(80);
const endedAtUnixMs = performance.timeOrigin + performance.now();
process.stdout.write(
  `${OPERATION_MARKER}${JSON.stringify({
    schemaVersion: 2,
    name: participant,
    startedAtUnixMs,
    endedAtUnixMs,
    population: 1,
    boundary: `${participant} boundary`,
    databaseIdentity: {
      database: 'fixture',
      role: 'fixture',
      applicationName: `q11-fixture-${participant}`,
    },
  })}\n`,
);
