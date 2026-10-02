import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateVitestGateReport } from '../coverage/validate-vitest-gate-report.mjs';

const vitest = (workspace, file) => [
  'pnpm',
  '--filter',
  workspace,
  'exec',
  'vitest',
  'run',
  '--config',
  'vitest.integration.config.ts',
  file,
];
export const CURATED_TEMPLATE_GATES = Object.freeze(
  [
    {
      id: 'origin-guard',
      minimumTests: 2340,
      command: vitest(
        '@pertexo/api',
        'test/curated-template-origin-guard.integration.test.ts',
      ),
      environment: { F06_ORIGIN_GUARD_OWNED_FIXTURE: 'true' },
    },
    {
      id: 'origin-boundary',
      minimumTests: 16,
      command: vitest(
        '@pertexo/database',
        'test/workflow-template-origin-boundary.integration.test.ts',
      ),
      environment: { F06_ORIGIN_BOUNDARY_OWNED_FIXTURE: 'true' },
    },
    {
      id: 'curated-browser',
      minimumTests: 1,
      command: vitest(
        '@pertexo/api',
        'test/editor-browser.integration.test.ts',
      ),
      environment: {
        EDITOR_BROWSER_INTEGRATION: 'true',
        EDITOR_BROWSER_CASE: 'curated-templates',
      },
    },
    {
      id: 'compiled-cutover',
      minimumTests: 10,
      command: [
        'node',
        '--test',
        '--test-reporter=./infrastructure/testing/curated-cutover-gate-reporter.mjs',
        'infrastructure/testing/curated-cutover.integration.test.mjs',
      ],
      environment: { F06_CUTOVER_OWNED_FIXTURE: 'true' },
    },
  ].map((gate) =>
    Object.freeze({
      ...gate,
      command: Object.freeze(gate.command),
      environment: Object.freeze(gate.environment),
    }),
  ),
);

export function assertCuratedQualification(manifest) {
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
      'Curated qualification requires stable clean source-bound passing evidence',
    );
  if (
    !Array.isArray(manifest.gates) ||
    manifest.gates.length !== CURATED_TEMPLATE_GATES.length
  )
    throw new Error('Curated qualification requires all four owned gates');
  for (const [index, gate] of CURATED_TEMPLATE_GATES.entries()) {
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
        `Curated qualification is missing exact owned gate ${gate.id}`,
      );
    const result = validateVitestGateReport(
      record.counts,
      gate.id,
      gate.minimumTests,
    );
    if (JSON.stringify(result) !== JSON.stringify(record.result))
      throw new Error(
        `Curated qualification has inconsistent counts for ${gate.id}`,
      );
  }
  return manifest;
}

export async function validateCuratedQualificationDirectory(
  directory,
  expectedSource,
) {
  const manifest = assertCuratedQualification(
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
      'Curated evidence belongs to a different qualification source',
    );
  for (const gate of manifest.gates) {
    const bytes = await readFile(path.join(directory, gate.report));
    if (
      createHash('sha256').update(bytes).digest('hex') !== gate.reportSha256 ||
      JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(gate.counts)
    )
      throw new Error(`Curated qualification report changed: ${gate.id}`);
  }
  return manifest;
}
