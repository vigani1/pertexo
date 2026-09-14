import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { CONTRACT_ARTIFACTS } from '../src/artifacts.js';

function collectReferences(
  value: unknown,
  references: string[] = [],
): readonly string[] {
  if (value === null || typeof value !== 'object') return references;
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, references);
    return references;
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (typeof record.$ref === 'string') references.push(record.$ref);
  for (const nested of Object.values(record))
    collectReferences(nested, references);
  return references;
}

function resolvesLocalReference(document: unknown, reference: string): boolean {
  if (!reference.startsWith('#/')) return reference === '#';
  let current = document;
  for (const encodedPart of reference.slice(2).split('/')) {
    if (current === null || typeof current !== 'object') return false;
    const part = encodedPart.replaceAll('~1', '/').replaceAll('~0', '~');
    current = (current as Readonly<Record<string, unknown>>)[part];
    if (current === undefined) return false;
  }
  return true;
}

describe('public contract artifact manifest', () => {
  it('keeps every committed artifact byte-identical to its producer', async () => {
    for (const artifact of CONTRACT_ARTIFACTS) {
      const committed = await readFile(
        new URL(`../artifacts/${artifact.fileName}`, import.meta.url),
        'utf8',
      );
      expect(committed, artifact.fileName).toBe(artifact.content);
    }
  });

  it('publishes only resolvable local references in every artifact', () => {
    for (const artifact of CONTRACT_ARTIFACTS) {
      const document = JSON.parse(artifact.content) as unknown;
      for (const reference of collectReferences(document))
        expect(
          resolvesLocalReference(document, reference),
          `${artifact.fileName}: ${reference}`,
        ).toBe(true);
    }
  });
});
