import { describe, expect, it, vi } from 'vitest';
import {
  HTTP_REQUEST_MANIFEST,
  httpPaginationSchema,
} from '@pertexo/integrations';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import type { NodeFormApi } from '@/features/workflow-editor/model/inspector/node-form';
import { withConfigValue } from '@/features/workflow-editor/model/inspector/draft';
import {
  nestedConfigForm,
  paginationForMode,
  paginationValue,
} from '@/features/workflow-editor/model/inspector/http-pagination/draft';
import { paginationFields } from '@/features/workflow-editor/model/inspector/http-pagination/fields';
import { outputFieldsOf } from '@/features/workflow-editor/model/inspector/input-mappings';

describe('HTTP pagination setup', () => {
  it.each(['next_link', 'cursor', 'page', 'offset'])(
    'starts %s with the integration defaults and only its fields',
    (mode) => {
      const value = paginationForMode(mode, undefined);
      expect(httpPaginationSchema.safeParse(value).success).toBe(true);
      expect(value).toMatchObject({
        maxPages: 10,
        delayMillis: 0,
        itemsPath: '$.data',
      });
      const fields = paginationFields(
        HTTP_REQUEST_MANIFEST.configSchema,
        mode,
        'body',
      );
      expect(
        fields.common.find((field) => field.key === 'itemsPath')?.format,
      ).toBe('json-path');
      expect(fields.common.map((field) => field.key)).toContain('maxPages');
      if (mode !== 'cursor')
        expect(fields.common.map((field) => field.key)).not.toContain(
          'cursorPath',
        );
      if (mode !== 'offset')
        expect(fields.common.map((field) => field.key)).not.toContain('step');
      expect(fields.source.map((field) => field.key)).toEqual(
        mode === 'next_link' ? ['path'] : [],
      );
    },
  );
  it('keeps common limits when changing mode and drops mode-specific settings', () => {
    const previous = {
      mode: 'cursor',
      parameter: 'after',
      cursorPath: '$.next',
      itemsPath: '$.records',
      maxPages: 3,
      delayMillis: 250,
    };
    expect(paginationForMode('offset', previous)).toEqual({
      mode: 'offset',
      parameter: 'offset',
      start: 0,
      step: 100,
      itemsPath: '$.records',
      maxPages: 3,
      delayMillis: 250,
    });
    expect(paginationForMode('off', previous)).toBeUndefined();
  });
  it('edits the current nested draft without losing siblings and namespaces unfinished input', () => {
    let node: WorkflowGraphContract['nodes'][number] = {
      id: 'http',
      definition: { key: 'http.request', version: 1 },
      configVersion: 1,
      position: { x: 0, y: 0 },
      connectionRefs: {},
      inputMappings: {},
      config: {
        headers: { 'X-Trace': 'old' },
        pagination: paginationForMode('next_link', undefined) ?? {},
      },
    };
    const scratch = vi.fn<NodeFormApi['reportScratch']>();
    const form: NodeFormApi = {
      nodeId: node.id,
      editable: true,
      reportScratch: scratch,
      commit: (update) => {
        node = {
          ...node,
          ...(typeof update === 'function' ? update(node) : update),
        };
      },
    };
    const nested = nestedConfigForm(form, 'pagination');
    const source = nestedConfigForm(nested, 'source');
    node = {
      ...node,
      config: { ...node.config, headers: { 'X-Trace': 'new' } },
    };
    nested.commit(
      (current) => ({ config: withConfigValue(current.config, 'maxPages', 3) }),
      'max-pages',
    );
    source.commit(
      (current) => ({
        config: withConfigValue(current.config, 'path', '$.links.next'),
      }),
      'next-path',
    );
    expect(node.config.headers).toEqual({ 'X-Trace': 'new' });
    expect(paginationValue(node.config)).toMatchObject({
      maxPages: 3,
      itemsPath: '$.data',
      source: { kind: 'body', path: '$.links.next' },
    });
    source.reportScratch('path', true);
    expect(scratch).toHaveBeenCalledWith('pagination:source:path', true);
  });
  it('offers items alongside the existing response fields in mappings', () => {
    expect(outputFieldsOf(HTTP_REQUEST_MANIFEST.outputSchema)).toContainEqual({
      key: 'items',
      type: 'array',
    });
    expect(
      outputFieldsOf(HTTP_REQUEST_MANIFEST.outputSchema).map(({ key }) => key),
    ).toEqual(
      expect.arrayContaining([
        'status',
        'headers',
        'body',
        'finalOrigin',
        'redirectCount',
        'pageCount',
        'complete',
      ]),
    );
  });
  it('does not claim one alternative’s type when union fields disagree', () => {
    expect(
      outputFieldsOf({
        anyOf: [
          { type: 'object', properties: { value: { type: 'number' } } },
          { type: 'object', properties: { value: { type: 'string' } } },
        ],
      }),
    ).toEqual([{ key: 'value' }]);
  });
});
