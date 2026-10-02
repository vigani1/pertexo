#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceIdentity } from '../quality/run-local-quality.mjs';
import {
  OwnedProcessSupervisor,
  runManagedCommand,
} from '../support/owned-process-tree.mjs';
import { validateVitestGateReport } from '../coverage/validate-vitest-gate-report.mjs';
import {
  verifyCuratedFixtureOwnership,
  recheckCuratedFixtureOwnership,
} from './curated-template-owned-fixture.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));

export async function runOwnedFeatureQualification(
  directory,
  profile,
  environment = process.env,
) {
  if (!path.isAbsolute(directory))
    throw new Error(
      'Owned feature reports directory must be absolute and fresh',
    );
  const started = await sourceIdentity(environment, repository);
  if (started.dirty)
    throw new Error(
      'Owned feature qualification requires frozen committed source',
    );
  const ownership = await verifyCuratedFixtureOwnership(environment);
  // Exclusive directory creation prevents consuming an older report after failure.
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory);
  const manifest = {
    version: 1,
    outcome: 'running',
    source: { started },
    ownership: {
      project: ownership.project,
      postgresId: ownership.postgresId,
      redisId: ownership.redisId,
    },
    gates: [],
  };
  const supervisor = new OwnedProcessSupervisor();
  let signal;
  const interrupted = (received) => {
    signal = received;
    void supervisor.terminateAll(received).catch(() => undefined);
  };
  const onInterrupt = () => interrupted('SIGINT');
  const onTerminate = () => interrupted('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  const persist = () =>
    writeFile(
      path.join(directory, 'qualification.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  try {
    await persist();
    for (const gate of profile.gates) {
      if (signal)
        throw new Error(`Owned feature qualification interrupted by ${signal}`);
      await recheckCuratedFixtureOwnership(ownership, environment);
      const reportPath = path.join(directory, `${gate.id}.json`);
      const env = {
        ...environment,
        ...gate.environment,
        ...profile.sourceEnvironment(started),
        CURATED_CUTOVER_GATE_REPORT: reportPath,
      };
      delete env.NODE_TEST_CONTEXT;
      const [command, ...args] = gate.command;
      const record = {
        id: gate.id,
        minimumTests: gate.minimumTests,
        command: gate.command,
        status: 'running',
        report: path.basename(reportPath),
      };
      manifest.gates.push(record);
      await persist();
      process.stdout.write(`Owned feature gate: ${gate.id}\n`);
      await runManagedCommand({
        command: command === 'node' ? process.execPath : command,
        args:
          command === 'node'
            ? args
            : [
                ...args,
                '--reporter=default',
                '--reporter=json',
                `--outputFile=${reportPath}`,
              ],
        spawnOptions: {
          cwd: repository,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
        spawnOwned: supervisor.spawn.bind(supervisor),
        releaseOwned: supervisor.release.bind(supervisor),
        onStdout: (bytes) => process.stdout.write(bytes),
        onStderr: (bytes) => process.stderr.write(bytes),
        failure: (code, received) =>
          new Error(`${gate.id} failed (${String(code)}, ${String(received)})`),
      });
      const bytes = await readFile(reportPath);
      record.counts = JSON.parse(bytes);
      record.result = validateVitestGateReport(
        record.counts,
        gate.id,
        gate.minimumTests,
      );
      record.reportSha256 = createHash('sha256').update(bytes).digest('hex');
      record.status = 'passed';
      await persist();
    }
    await recheckCuratedFixtureOwnership(ownership, environment);
    await supervisor.terminateAll();
    manifest.source.completed = await sourceIdentity(environment, repository);
    manifest.outcome = 'passed';
    profile.assert(manifest);
    await persist();
    await profile.validateDirectory(directory, started);
    if (signal)
      throw new Error(`Owned feature qualification interrupted by ${signal}`);
    return manifest;
  } catch (error) {
    manifest.outcome = 'failed';
    // Do not persist process errors: dependency diagnostics can contain URLs.
    manifest.failure = signal
      ? `interrupted-${signal}`
      : 'required-gate-or-source-validation-failed';
    try {
      await supervisor.terminateAll();
    } catch (cleanupError) {
      manifest.failure = 'owned-process-cleanup-failed';
      await persist();
      throw new AggregateError(
        [error, cleanupError],
        'Owned feature qualification and owned cleanup failed',
      );
    }
    await persist();
    throw error;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}
