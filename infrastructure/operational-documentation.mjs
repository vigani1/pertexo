import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Historical audit evidence deliberately retains its original scalar values.
// These rules protect only the live operational sections from duplicating them.
export function validateOperationalReferences({ status, inventory, security }) {
  const currentStatus = status.split(
    '## Historical engineering remediation',
  )[0];
  const migrationRow =
    inventory
      .split('\n')
      .find((line) => line.startsWith('| Database rolling head |')) ?? '';
  const registryRow =
    inventory
      .split('\n')
      .find((line) => line.startsWith('| Node/executor release history |')) ??
    '';
  const dependencyCommand =
    security
      .split('- `pnpm security:audit`')[1]
      ?.split('- `pnpm deployment:check`')[0] ?? '';
  const errors = [];
  for (const [label, contents, required] of [
    [
      'current status',
      currentStatus,
      [
        './implementation-progress.md#independent-audit-remediation--follow-up-corrections',
        '../packages/database/src/platform/readiness.ts',
        '../packages/database/migrations/migration-execution-plan.json',
      ],
    ],
    [
      'migration inventory',
      migrationRow,
      [
        '../../packages/database/src/platform/readiness.ts',
        '../../packages/database/migrations/migration-execution-plan.json',
      ],
    ],
    [
      'release inventory',
      registryRow,
      ['../../packages/node-catalog/src/registry.ts'],
    ],
    [
      'dependency policy',
      dependencyCommand,
      ['../../package.json', '--audit-level'],
    ],
  ]) {
    for (const reference of required) {
      if (!contents.includes(reference))
        errors.push(`${label}: missing authoritative reference ${reference}`);
    }
  }
  if (/\b\d{4}_[a-z_]+\.sql\b/u.test(currentStatus + migrationRow)) {
    errors.push(
      'current migration guidance must reference executable state, not duplicate a migration filename',
    );
  }
  if (/epoch \d+ is current maximum/iu.test(registryRow)) {
    errors.push('current release maximum must come from the registry');
  }
  if (/\b(?:low|moderate|high|critical)\b/iu.test(dependencyCommand)) {
    errors.push(
      'dependency severity must come from the executable audit-level policy',
    );
  }
  if (errors.length > 0) throw new Error(errors.join('\n'));
}

export async function validateOperationalDocumentation(root) {
  const [status, inventory, security] = await Promise.all(
    [
      'docs/current-implementation-status.md',
      'docs/operations/compatibility-retirement-inventory.md',
      'docs/operations/release-security-gate.md',
    ].map((file) => readFile(path.join(root, file), 'utf8')),
  );
  validateOperationalReferences({ status, inventory, security });
}
