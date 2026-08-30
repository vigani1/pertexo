#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import process from 'node:process';

const digestPattern = /@sha256:[0-9a-f]{64}$/u;
const imagePattern = /(?:image:\s*|^[A-Z][A-Z0-9_]*_IMAGE=)([^\s#]+)/u;

/**
 * Validate that every container image reference in a checked-in deployment
 * contract names both a human-readable tag and an immutable manifest digest.
 *
 * This intentionally validates text rather than resolving tags at check time:
 * a CI check must remain deterministic and must not silently accept a newly
 * moved registry tag.
 */
export function validateImagePins(source, label) {
  const errors = [];
  for (const [index, line] of source.split('\n').entries()) {
    const match = imagePattern.exec(line.trim());
    if (!match) continue;
    const reference = match[1].replace(
      /^\$\{[A-Z][A-Z0-9_]*:-([^}]+)\}$/u,
      '$1',
    );
    if (
      reference.includes('${{') ||
      reference.startsWith('pertexo-release-gate:')
    )
      continue;
    if (!digestPattern.test(reference)) {
      errors.push(
        `${label}:${index + 1}: image reference must end in a sha256 digest: ${reference}`,
      );
    }
    const withoutDigest = reference.replace(/@sha256:[0-9a-f]{64}$/u, '');
    if (!withoutDigest.includes(':')) {
      errors.push(
        `${label}:${index + 1}: image reference must retain a readable tag before its digest: ${reference}`,
      );
    }
  }
  return errors;
}

const files = [
  'compose.yaml',
  'infrastructure/observability/compose.yaml',
  '.env.example',
  '.github/workflows/ci.yml',
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const errors = [];
  for (const file of files) {
    errors.push(...validateImagePins(await readFile(file, 'utf8'), file));
  }
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(
      `Validated immutable image pins in ${files.length} deployment contracts.`,
    );
  }
}
