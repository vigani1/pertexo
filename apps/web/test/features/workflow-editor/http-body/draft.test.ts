import { describe, expect, it } from 'vitest';
import {
  applyBodyValue,
  bodyDraft,
  bodyValue,
  newFormPart,
  populatedSource,
  validateBodyDraft,
} from '@/features/workflow-editor/model/inspector/http-body';
import type {
  WorkflowNode,
  GraphLevel,
} from '@/features/workflow-editor/model/graph/scopes';
const node: WorkflowNode = {
  id: 'http',
  definition: { key: 'http.request', version: 1 },
  configVersion: 1,
  config: {
    method: 'POST',
    url: 'https://example.test/upload',
    headers: { accept: 'application/json' },
  },
  inputMappings: {
    body: { kind: 'literal', value: { encoding: 'utf8', value: 'original' } },
  },
  connectionRefs: {},
  position: { x: 0, y: 0 },
};
const graph: GraphLevel = { nodes: [node], edges: [] };
const file = {
  kind: 'artifact',
  artifactId: '11111111-1111-4111-8111-111111111111',
  byteLength: 4,
  mediaType: 'application/octet-stream',
  sha256: 'a'.repeat(64),
};
describe('HTTP body draft', () => {
  it('preserves raw inputs and unrelated HTTP setup when composing multipart', () => {
    const value = bodyValue(node);
    if (value === undefined) throw new Error('Raw body missing');
    expect(bodyDraft(value)).toEqual({
      mode: 'raw',
      mappings: node.inputMappings,
    });
    const text = newFormPart('text');
    const result = validateBodyDraft(
      { mode: 'multipart', parts: [{ ...text, name: 'message' }] },
      graph,
      node.id,
    );
    expect(result.error).toBeUndefined();
    if (result.value === undefined) throw new Error('Expected valid text part');
    const updated = applyBodyValue(result.value, node);
    expect(updated.config).toMatchObject(node.config);
    expect(updated.inputMappings).toEqual({
      [text.inputKey]: { kind: 'literal', value: '' },
    });
    expect(updated.config.multipart).toEqual({
      parts: [{ inputKey: text.inputKey, name: 'message', kind: 'text' }],
    });
    expect(node.inputMappings).toHaveProperty('body');
  });
  it('keeps stable part keys and their mappings through reordered snapshots', () => {
    const first = newFormPart('text');
    const second = newFormPart('file');
    const ready = {
      ...second,
      source: {
        id: second.inputKey,
        destinationKey: second.inputKey,
        kind: 'literal' as const,
        literalJson: JSON.stringify(file),
      },
    };
    const result = validateBodyDraft(
      { mode: 'multipart', parts: [ready, first] },
      graph,
      node.id,
    );
    expect(result.knownBytes).toBe(4);
    if (result.value === undefined) throw new Error('Expected multipart value');
    const restored = bodyDraft(result.value);
    expect(restored.mode).toBe('multipart');
    if (restored.mode !== 'multipart') throw new Error('Multipart missing');
    expect(restored.parts.map((part) => part.inputKey)).toEqual([
      second.inputKey,
      first.inputKey,
    ]);
    expect(restored.parts[0]?.source).toMatchObject({
      id: second.inputKey,
      destinationKey: second.inputKey,
      kind: 'literal',
    });
    const restoredSource = restored.parts[0]?.source;
    if (restoredSource?.kind !== 'literal')
      throw new Error('Expected literal file');
    expect(JSON.parse(restoredSource.literalJson) as unknown).toEqual(file);
    expect(result.value.inputMappings[second.inputKey]).toEqual({
      kind: 'literal',
      value: file,
    });
  });
  it('keeps incomplete file values and invalid metadata in scratch, without changing saved mappings', () => {
    const part = newFormPart('file');
    const result = validateBodyDraft(
      {
        mode: 'multipart',
        parts: [
          {
            ...part,
            name: '',
            filename: '../wrong',
            contentType: 'not-a-type',
          },
        ],
      },
      graph,
      node.id,
    );
    expect(result.value).toBeUndefined();
    for (const field of ['name', 'filename', 'contentType'] as const)
      expect(result.parts[part.inputKey]?.[field]).toBeTypeOf('string');
    expect(result.parts[part.inputKey]?.source).toBe(
      'Upload a file or map a finalized file reference.',
    );
    expect(node.inputMappings).toHaveProperty('body');
  });
  it('checks literal value types and exact UTF-8 size, while keeping dynamic mappings dynamic', () => {
    const part = newFormPart('text');
    const value = {
      ...part,
      source: { ...part.source, kind: 'literal' as const, literalJson: '"€"' },
    };
    expect(
      validateBodyDraft({ mode: 'multipart', parts: [value] }, graph, node.id)
        .knownBytes,
    ).toBe(3);
    expect(
      validateBodyDraft(
        {
          mode: 'multipart',
          parts: [
            {
              ...part,
              source: {
                id: part.inputKey,
                destinationKey: part.inputKey,
                kind: 'literal',
                literalJson: '42',
              },
            },
          ],
        },
        graph,
        node.id,
      ).value,
    ).toBeUndefined();
    const dynamic = validateBodyDraft(
      {
        mode: 'multipart',
        parts: [
          {
            ...part,
            source: {
              id: part.inputKey,
              destinationKey: part.inputKey,
              kind: 'run_input',
              path: '$.message',
            },
          },
        ],
      },
      graph,
      node.id,
    );
    expect(dynamic.unknownSize).toBe(true);
    expect(dynamic.value?.inputMappings[part.inputKey]).toEqual({
      kind: 'run_input',
      path: '$.message',
    });
  });
  it('refuses a full-size file before framing and counts every repeated file part', () => {
    const first = newFormPart('file');
    const second = newFormPart('file');
    function ready(part: typeof first, size: number) {
      return {
        ...part,
        source: {
          id: part.inputKey,
          destinationKey: part.inputKey,
          kind: 'literal' as const,
          literalJson: JSON.stringify({ ...file, byteLength: size }),
        },
      };
    }
    const below = validateBodyDraft(
      { mode: 'multipart', parts: [ready(first, 2097152)] },
      graph,
      node.id,
    );
    expect(below.error).toBeUndefined();
    expect(below.knownBytes).toBe(2097152);
    for (const parts of [
      [ready(first, 10485760)],
      [ready(first, 10485761)],
      [ready(first, 6000000), ready(second, 6000000)],
    ]) {
      const result = validateBodyDraft(
        { mode: 'multipart', parts },
        graph,
        node.id,
      );
      expect(result).not.toHaveProperty('value');
      expect(result).toMatchObject({
        error:
          'Known part data already fills 10 MB before form headers. Use smaller files or split them into separate uploads.',
      });
    }
  });
  it('gives every refused form its own reason', () => {
    const text = newFormPart('text');
    const refused = [
      // A part without a name.
      [{ ...text, name: '' }],
      // A text part holding a number.
      [
        {
          ...text,
          name: 'message',
          source: {
            id: text.inputKey,
            destinationKey: text.inputKey,
            kind: 'literal' as const,
            literalJson: '42',
          },
        },
      ],
    ];
    for (const parts of refused) {
      const result = validateBodyDraft(
        { mode: 'multipart', parts },
        graph,
        node.id,
      );
      expect(result).not.toHaveProperty('value');
      expect(result).toMatchObject({
        error:
          'Finish the form parts before saving. Each part needs a name and a matching value.',
      });
    }
  });
  it('refuses unsupported stored metadata and explicitly clears the form without altering other setup', () => {
    expect(
      bodyValue({
        ...node,
        config: { ...node.config, multipart: { parts: [] } },
      }),
    ).toBeUndefined();
    const part = newFormPart('text');
    const parsed = validateBodyDraft(
      { mode: 'multipart', parts: [part] },
      graph,
      node.id,
    );
    if (parsed.value === undefined) throw new Error('Expected valid form');
    const stored: WorkflowNode = {
      ...node,
      ...applyBodyValue(parsed.value, node),
    };
    expect(
      applyBodyValue({ multipart: undefined, inputMappings: {} }, stored),
    ).toEqual({ config: node.config, inputMappings: {} });
    expect(populatedSource(part.source)).toBe(false);
    expect(
      populatedSource({
        id: 'x',
        destinationKey: 'x',
        kind: 'literal',
        literalJson: JSON.stringify(file),
      }),
    ).toBe(true);
  });
});
