import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/templates';
import {
  configureTemplate,
  setupValueError,
} from '@/features/workflows/model/curated-template-setup';

const controlled = CURATED_WORKFLOW_TEMPLATES.find(
  (template) => template.templateId === 'controlled-http-notification',
);
if (controlled === undefined)
  throw new Error('Missing reviewed controlled template');
const endpoint = controlled.setupTargets.find(
  (target) => target.valueKind === 'https_endpoint',
);
if (endpoint === undefined)
  throw new Error('Missing reviewed curated HTTPS v1 target');

describe('Browser-owned curated HTTPS v1 setup policy', () => {
  it('agrees with the shared three-tier golden corpus and keeps admitted bytes exact', async () => {
    const raw: unknown = JSON.parse(
      await readFile(
        resolve(
          process.cwd(),
          '../../packages/templates/test/fixtures/https-endpoint-corpus.json',
        ),
        'utf8',
      ),
    );
    if (!Array.isArray(raw) || raw.length === 0)
      throw new Error('Missing curated HTTPS golden corpus');
    let stringCases = 0;
    for (const item of raw as unknown[]) {
      if (
        typeof item !== 'object' ||
        item === null ||
        !('name' in item) ||
        typeof item.name !== 'string' ||
        !('value' in item) ||
        !('accepted' in item) ||
        typeof item.accepted !== 'boolean'
      )
        throw new Error('Invalid curated HTTPS golden case');
      if (typeof item.value !== 'string') continue; // Text controls cannot submit nonstrings.
      stringCases++;
      expect(
        setupValueError(endpoint, item.value) === undefined,
        item.name,
      ).toBe(item.accepted);
      const configured = configureTemplate(controlled, [
        item.value,
        'CF06QUALIFY',
      ]);
      expect(configured !== undefined, item.name).toBe(item.accepted);
      if (configured !== undefined)
        expect(
          configured.graph.nodes.find((node) => node.id === endpoint.nodeId)
            ?.config[endpoint.key],
          item.name,
        ).toBe(item.value);
    }
    expect(stringCases).toBeGreaterThan(100);
  });

  it.each([
    'https:example.test',
    'https://EXAMPLE.test/',
    'https://example.test:443/',
    'https://xn--9ca.example/',
    'https://example.test/#',
    'https://example.test/%2E/',
    'https://example.test/?%61uth=x',
  ])(
    'rejects previously parser-normalizable curated input %s without changing ordinary import rules',
    (value) => {
      expect(setupValueError(endpoint, value)).toContain('lowercase https://');
      expect(
        configureTemplate(controlled, [value, 'CF06QUALIFY']),
      ).toBeUndefined();
    },
  );

  it('does not normalize percent-encoded bytes, repeated segments or duplicate safe query names', () => {
    const value = 'https://example.test/a//%252E/%C3%A9?q=%FF&q=';
    const configured = configureTemplate(controlled, [value, 'CF06QUALIFY']);
    expect(
      configured?.graph.nodes.find((node) => node.id === endpoint.nodeId)
        ?.config[endpoint.key],
    ).toBe(value);
  });
});
