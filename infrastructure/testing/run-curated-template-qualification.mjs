#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sourceIdentity } from '../quality/run-local-quality.mjs';
import {
  OwnedProcessSupervisor,
  runManagedCommand,
} from '../support/owned-process-tree.mjs';
import { validateVitestGateReport } from '../coverage/validate-vitest-gate-report.mjs';
import {
  CURATED_TEMPLATE_GATES,
  assertCuratedQualification,
  validateCuratedQualificationDirectory,
} from './curated-template-gates.mjs';
import {
  verifyCuratedFixtureOwnership,
  recheckCuratedFixtureOwnership,
} from './curated-template-owned-fixture.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));

export async function runCuratedTemplateQualification(
  directory,
  environment = process.env,
) {
  if (!path.isAbsolute(directory))
    throw new Error('Curated reports directory must be absolute and fresh');
  const started = await sourceIdentity(environment, repository);
  if (started.dirty)
    throw new Error('Curated qualification requires frozen committed source');
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
    for (const gate of CURATED_TEMPLATE_GATES) {
      if (signal)
        throw new Error(`Curated qualification interrupted by ${signal}`);
      await recheckCuratedFixtureOwnership(ownership, environment);
      const reportPath = path.join(directory, `${gate.id}.json`);
      const env = {
        ...environment,
        ...gate.environment,
        F06_CUTOVER_COMPATIBLE_SOURCE: started.head,
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
      process.stdout.write(`Curated owned gate: ${gate.id}\n`);
      await runManagedCommand({
        command: command === 'node' ? process.execPath : command,
        args:
          gate.id === 'compiled-cutover'
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
    assertCuratedQualification(manifest);
    await persist();
    await validateCuratedQualificationDirectory(directory, started);
    if (signal)
      throw new Error(`Curated qualification interrupted by ${signal}`);
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
        'Curated qualification and owned cleanup failed',
      );
    }
    await persist();
    throw error;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [option, directory, ...extra] = process.argv.slice(2);
  if (option !== '--reports-directory' || !directory || extra.length)
    throw new Error(
      'usage: run-curated-template-qualification.mjs --reports-directory <fresh-absolute-directory>',
    );
  await runCuratedTemplateQualification(directory);
}
