import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateVitestGateReport } from '../coverage/validate-vitest-gate-report.mjs';

export const ownedVitestCommand = (workspace, ...files) => [
  'pnpm',
  '--filter',
  workspace,
  'exec',
  'vitest',
  'run',
  '--config',
  'vitest.integration.config.ts',
  ...files,
];

/** Shared evidence mechanics; feature wrappers retain their exact registries. */
export function createOwnedQualificationEvidence({
  gates,
  label,
  exactTests = false,
}) {
  function assertQualification(manifest) {
    const source = manifest?.source;
    if (
      manifest?.version !== 1 ||
      manifest.outcome !== 'passed' ||
      source?.started?.dirty !== false ||
      source?.completed?.dirty !== false ||
      !/^[a-f0-9]{40}$/u.test(source?.started?.head ?? '') ||
      !/^[a-f0-9]{64}$/u.test(source?.started?.fingerprint ?? '') ||
      source.started.head !== source.completed.head ||
      source.started.fingerprint !== source.completed.fingerprint
    )
      throw new Error(
        `${label} qualification requires stable clean source-bound passing evidence`,
      );
    if (
      !Array.isArray(manifest.gates) ||
      manifest.gates.length !== gates.length
    )
      throw new Error(`${label} qualification requires all four owned gates`);
    for (const [index, gate] of gates.entries()) {
      const record = manifest.gates[index];
      if (
        record?.id !== gate.id ||
        record.status !== 'passed' ||
        record.minimumTests !== gate.minimumTests ||
        JSON.stringify(record.command) !== JSON.stringify(gate.command) ||
        record.report !== `${gate.id}.json` ||
        !/^[a-f0-9]{64}$/u.test(record.reportSha256 ?? '')
      )
        throw new Error(
          `${label} qualification is missing exact owned gate ${gate.id}`,
        );
      const result = validateVitestGateReport(
        record.counts,
        gate.id,
        gate.minimumTests,
      );
      if (
        exactTests &&
        (result.passed !== gate.minimumTests ||
          result.total !== gate.minimumTests)
      )
        throw new Error(
          `${label} qualification requires exact test counts for ${gate.id}`,
        );
      if (JSON.stringify(result) !== JSON.stringify(record.result))
        throw new Error(
          `${label} qualification has inconsistent counts for ${gate.id}`,
        );
    }
    return manifest;
  }
  async function validateDirectory(directory, expectedSource) {
    const manifest = assertQualification(
      JSON.parse(
        await readFile(path.join(directory, 'qualification.json'), 'utf8'),
      ),
    );
    if (
      expectedSource !== undefined &&
      (manifest.source.started.head !== expectedSource.head ||
        manifest.source.started.fingerprint !== expectedSource.fingerprint)
    )
      throw new Error(
        `${label} evidence belongs to a different qualification source`,
      );
    for (const gate of manifest.gates) {
      const bytes = await readFile(path.join(directory, gate.report));
      if (
        createHash('sha256').update(bytes).digest('hex') !==
          gate.reportSha256 ||
        JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(gate.counts)
      )
        throw new Error(`${label} qualification report changed: ${gate.id}`);
    }
    return manifest;
  }
  return Object.freeze({ assertQualification, validateDirectory });
}
