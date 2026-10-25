import {
  connectionSlotKey,
  downloadPortableWorkflow,
  optionalConnectionSlots,
  readPortableWorkflowFile,
} from '@/features/workflows/model/portability';

import {
  WORKFLOW_PORTABILITY_LIMITS,
  workflowPortableManifestSchema,
} from '@pertexo/workflow-model';

import { describe, expect, it, vi } from 'vitest';

import { graphOf } from '../list/fixtures';

import { manifest } from './fixture';

describe('Portable workflow review and import', () => {
  it('says why a file can’t be imported, naming the tool it came from', async () => {
    const reason = (content: string) =>
      readPortableWorkflowFile(new File([content], 'workflow.json')).then(
        () => 'imported',
        (error: unknown) => (error instanceof Error ? error.message : ''),
      );
    expect(await reason('{"format": "pertexo.workflow", "graph": {')).toBe(
      'This file isn’t valid JSON. Choose a workflow file exported from Pertexo.',
    );
    expect(
      await reason(
        JSON.stringify({ name: 'Flow', nodes: [], connections: {} }),
      ),
    ).toMatch(/^This looks like an n8n workflow\./u);
    expect(await reason(JSON.stringify({ flow: [], metadata: {} }))).toMatch(
      /^This looks like a Make scenario\./u,
    );
    expect(await reason(JSON.stringify({ hello: 'world' }))).toBe(
      'This isn’t a Pertexo workflow file. Choose one made with Export… on a workflow.',
    );
    expect(
      await reason(JSON.stringify({ format: 'pertexo.workflow', graph: 1 })),
    ).toMatch(/^This Pertexo workflow file is damaged/u);
    expect(await reason(' '.repeat(2_097_153))).toBe(
      'This file is larger than 2 MB, the most a workflow file can be.',
    );
  });
  it('asks only for the connections a file’s steps need', () => {
    const portable = workflowPortableManifestSchema.parse({
      format: 'pertexo.workflow',
      graph: {
        nodes: [
          {
            id: 'call',
            definition: { key: 'http.request', version: 1 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
        settings: {},
      },
      requirements: {
        definitions: [{ key: 'http.request', version: 1, configVersion: 1 }],
      },
      connectionSlots: [
        {
          nodeId: 'call',
          slot: 'http_headers',
          providerKey: 'http',
          authType: 'http_headers',
        },
      ],
    });
    expect([
      ...optionalConnectionSlots(portable, [
        {
          definition: { key: 'http.request', version: 1 },
          optionalConnections: ['http_headers'],
        },
      ]),
    ]).toEqual([connectionSlotKey('call', 'http_headers')]);
    expect(
      optionalConnectionSlots(portable, [
        { definition: { key: 'http.request', version: 1 } },
      ]).size,
    ).toBe(0);
  });
  it('keeps downloads compact so pretty-print expansion cannot make a valid file unimportable', async () => {
    const graph = graphOf([{ id: 'source', key: 'core.manual', x: 0 }]);
    const node = graph.nodes[0];
    if (node === undefined) throw new Error('Source node fixture missing');
    node.config = Object.fromEntries(
      Array.from({ length: 100_000 }, (_, index) => [
        `a${index.toString(36)}`,
        0,
      ]),
    );
    const portable = workflowPortableManifestSchema.parse({
      ...manifest,
      graph,
      requirements: {
        ...manifest.requirements,
        definitions: [{ key: 'core.manual', version: 1, configVersion: 1 }],
      },
    });
    expect(
      new TextEncoder().encode(JSON.stringify(portable, null, 2)).byteLength,
    ).toBeGreaterThan(WORKFLOW_PORTABILITY_LIMITS.bytes);
    let downloaded: Blob | undefined;
    const oldCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      if (blob instanceof Blob) downloaded = blob;
      return 'blob:compact';
    };
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    try {
      downloadPortableWorkflow(portable);
      if (downloaded === undefined) throw new Error('Download blob missing');
      expect(downloaded.size).toBeLessThan(WORKFLOW_PORTABILITY_LIMITS.bytes);
      await expect(
        readPortableWorkflowFile(new File([downloaded], 'portable.json')),
      ).resolves.toEqual(portable);
    } finally {
      URL.createObjectURL = oldCreate;
      click.mockRestore();
    }
  });
});
