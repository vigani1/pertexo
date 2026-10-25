import { schemaFields } from '@/features/workflow-editor/model/inspector/draft';
import { parseItemPath } from '@/features/workflow-editor/model/inspector/item-path';
import type {
  NodeDefinitionCatalogItem,
  WorkflowGraphContract,
} from '@pertexo/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  findCanvas,
  pressSave,
} from '../../../support/fixtures/editor-actions';
import {
  editorHandlers,
  editorPath,
  setDefinition,
} from '../../../support/fixtures/workflow-editor';
import { mockServer } from '../../../support/mock-server';
import { renderApp } from '../../../support/render-app';

describe('item paths', () => {
  it('stores a typed field name as the path it means', () => {
    expect(parseItemPath('email')).toEqual({ ok: true, value: '$.email' });
    expect(parseItemPath(' order.total ')).toEqual({
      ok: true,
      value: '$.order.total',
    });
    expect(parseItemPath('items[0].id')).toEqual({
      ok: true,
      value: '$.items[0].id',
    });
    expect(parseItemPath('[0]')).toEqual({ ok: true, value: '$[0]' });
    expect(parseItemPath('first name')).toEqual({
      ok: true,
      value: "$['first name']",
    });
    expect(parseItemPath("it's")).toEqual({ ok: true, value: "$['it\\'s']" });
    // Written paths, including the whole item, stay as they are.
    expect(parseItemPath('$')).toEqual({ ok: true, value: '$' });
    expect(parseItemPath('$.a.b')).toEqual({ ok: true, value: '$.a.b' });
  });

  it('says how to write a path it can’t read', () => {
    expect(parseItemPath('')).toEqual({
      ok: false,
      error: 'Write a field like email, or a path like items[0].id.',
    });
    expect(parseItemPath('email[').ok).toBe(false);
    expect(parseItemPath('a..b').ok).toBe(false);
    expect(parseItemPath('$.').ok).toBe(false);
    expect(
      parseItemPath(Array.from({ length: 65 }, () => 'a').join('.')),
    ).toEqual({
      ok: false,
      error: 'Paths can be at most 512 bytes and 64 levels deep.',
    });
  });

  it('marks only text settings the catalog calls paths', () => {
    const [path, name, count] = schemaFields({
      type: 'object',
      properties: {
        path: { type: 'string', format: 'json-path' },
        name: { type: 'string', format: 'email' },
        count: { type: 'integer', format: 'json-path' },
      },
    });
    expect(path).toMatchObject({ format: 'json-path' });
    expect(name).not.toHaveProperty('format');
    expect(count).not.toHaveProperty('format');
  });
});

const sortDefinition = {
  ...setDefinition,
  definition: { key: 'core.sort', version: 1 },
  family: 'transform',
  configSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', format: 'json-path', title: 'Sort by' },
    },
    required: ['path'],
  },
} satisfies NodeDefinitionCatalogItem;

function sortGraph(): WorkflowGraphContract {
  return {
    nodes: [
      {
        id: 'sort',
        label: 'Sort orders',
        definition: { key: 'core.sort', version: 1 },
        position: { x: 80, y: 80 },
        configVersion: 1,
        config: { path: '$.id' },
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [],
    settings: {},
  };
}

describe('a path setting in Setup', { timeout: 30_000 }, () => {
  it('takes a field name and saves the path', async () => {
    let saved: WorkflowGraphContract | undefined;
    mockServer.use(
      ...editorHandlers(
        (_request, body) => {
          saved = body.graph;
        },
        { graph: sortGraph(), definitions: [sortDefinition] },
      ),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Sort orders'));
    const field = screen.getByLabelText('Sort by');
    await event.clear(field);
    // user-event reads "[[" as one "[".
    await event.type(field, 'email[[');
    await event.tab();
    expect(
      await screen.findByText(
        'Write a field like email, or a path like items[0].id.',
      ),
    ).toBeVisible();

    await event.clear(field);
    await event.type(field, 'total');
    expect(
      screen.queryByText(
        'Write a field like email, or a path like items[0].id.',
      ),
    ).not.toBeInTheDocument();
    pressSave();
    await waitFor(() => {
      expect(saved?.nodes[0]?.config).toEqual({ path: '$.total' });
    });
  });
});
