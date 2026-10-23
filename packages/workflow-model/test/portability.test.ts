import { describe, expect, it } from 'vitest';

import {
  canonicalWorkflowPortableJson,
  parsePortableJson,
  PortableJsonError,
  WORKFLOW_PORTABILITY_LIMITS,
} from '../src/authoring/portability/contract.js';
import {
  inspectWorkflowPortableManifest,
  projectWorkflowPortableManifest,
} from '../src/authoring/portability/projection.js';
import { catalog, node, graph } from './support/portability.js';
describe('portable raw JSON admission', () => {
  it('keeps retry settings when exporting and importing a workflow', () => {
    const original = graph([
      { ...node('action'), retry: { maximumAttempts: 5, delayMillis: 60_000 } },
    ]);
    const manifest = projectWorkflowPortableManifest(original, catalog);
    expect(
      inspectWorkflowPortableManifest(manifest, [], catalog).graph,
    ).toEqual(original);
  });
  it.each([
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '[{"x":1,"x":2}]',
    '{"a":{"a":1,"a":2}}',
    '{',
    ']',
    '{"a":[}',
    '{"x":"unterminated}',
    '{"a":undefined}',
    '{"a":NaN}',
    '1e999',
    '{"a":true,}',
  ])(
    'rejects malformed or duplicate raw JSON without reflecting input: %s',
    (text) => {
      expect(() => parsePortableJson(text)).toThrow(PortableJsonError);
      try {
        parsePortableJson(text);
      } catch (error) {
        expect(String(error)).not.toContain(text);
      }
    },
  );
  it('handles repeated keys in different scopes and quoted structural punctuation', () => {
    expect(parsePortableJson('{"a":{"a":"{[,]}\\""},"b":{"a":2}}')).toEqual({
      a: { a: '{[,]}"' },
      b: { a: 2 },
    });
  });
  it('counts UTF-8 bytes and rejects depth before recursive parsing', () => {
    expect(() =>
      parsePortableJson(
        `"${'é'.repeat(WORKFLOW_PORTABILITY_LIMITS.bytes / 2)}"`,
      ),
    ).toThrow(PortableJsonError);
    expect(() =>
      parsePortableJson('['.repeat(257) + '0' + ']'.repeat(257)),
    ).toThrow(PortableJsonError);
    expect(
      parsePortableJson('['.repeat(255) + '0' + ']'.repeat(255)),
    ).toBeDefined();
  });
  it('bounds strings/large arrays even before JSON syntax is valid', () => {
    expect(() =>
      parsePortableJson(' '.repeat(WORKFLOW_PORTABILITY_LIMITS.bytes + 1)),
    ).toThrow(PortableJsonError);
    expect(() => canonicalWorkflowPortableJson(new Array(2_097_152))).toThrow(
      PortableJsonError,
    );
  });
  it('never invokes accessors, accepts cycles or non-plain prototypes', () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'graph', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return {};
      },
    });
    expect(() => canonicalWorkflowPortableJson(accessor)).toThrow(
      PortableJsonError,
    );
    expect(getterCalls).toBe(0);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalWorkflowPortableJson(cyclic)).toThrow(
      PortableJsonError,
    );
    expect(() => canonicalWorkflowPortableJson(new Date())).toThrow(
      PortableJsonError,
    );
    expect(() => canonicalWorkflowPortableJson({ value: undefined })).toThrow(
      PortableJsonError,
    );
  });
  it('canonicalizes only bounded own JSON data independent of object order', () => {
    expect(
      canonicalWorkflowPortableJson({ b: [false, null, -0], a: 'é' }),
    ).toBe('{"a":"é","b":[false,null,0]}');
    const original = parsePortableJson('{"__proto__":{"x":1}}');
    expect(canonicalWorkflowPortableJson(original)).toBe(
      '{"__proto__":{"x":1}}',
    );
    expect(Object.prototype).not.toHaveProperty('x');
  });
});
