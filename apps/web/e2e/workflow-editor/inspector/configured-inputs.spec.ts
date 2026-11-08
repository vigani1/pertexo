import { platformBrowserNodeDefinitionCatalog } from '@pertexo/node-catalog';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import { expect, test } from '../../support/fixtures';
import {
  addCsrfCookie,
  definition,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
} from '../support';
import {
  httpDraft,
  installHttp,
  openSetup,
  savedHttpNode,
} from './http-setup/fixture';

for (const width of [375, 1280]) {
  test(`preserves editable address and header inputs across HTTP body changes at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await addCsrfCookie(context);
    const remote = httpDraft();
    const initial = savedHttpNode(remote);
    remote.graph = {
      ...remote.graph,
      nodes: [
        {
          ...initial,
          config: {
            ...initial.config,
            method: 'POST',
            url: 'https://example.test/orders/{orderId}',
            headers: { 'X-Trace': '{traceId}' },
          },
          inputMappings: {
            orderId: { kind: 'run_input', path: '$.orderId' },
            traceId: { kind: 'literal', value: 'trace' },
            body: { kind: 'literal', value: 'old body' },
          },
        },
      ],
    };
    await installHttp(page, remote);
    await page.goto(editorUrl);
    await openSetup(page, width);
    await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
    await page.getByRole('button', { name: 'Form parts', exact: true }).click();
    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    const request = page.getByRole('region', {
      name: 'Address and header inputs',
    });
    await expect(request).toContainText('orderId');
    await expect(request).toContainText('traceId');
    const part = page.getByRole('group', { name: /^Part 1:/u });
    await part.getByLabel('Value', { exact: true }).fill('first part');
    await expect
      .poll(() => savedHttpNode(remote).inputMappings.orderId)
      .toEqual({ kind: 'run_input', path: '$.orderId' });
    await expect
      .poll(() => Object.values(savedHttpNode(remote).inputMappings))
      .toContainEqual({ kind: 'literal', value: 'first part' });
    await page.reload();
    await openSetup(page, width);
    await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
    await part.getByLabel('Value', { exact: true }).fill('edited part');
    await expect
      .poll(() => Object.values(savedHttpNode(remote).inputMappings))
      .toContainEqual({ kind: 'literal', value: 'edited part' });
    expect(savedHttpNode(remote).inputMappings.traceId).toEqual({
      kind: 'literal',
      value: 'trace',
    });
    await page.getByRole('button', { name: 'Raw body', exact: true }).click();
    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    await expect
      .poll(() => savedHttpNode(remote).config.multipart)
      .toBeUndefined();
    expect(savedHttpNode(remote).inputMappings).toEqual({
      orderId: { kind: 'run_input', path: '$.orderId' },
      traceId: { kind: 'literal', value: 'trace' },
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });

  test(`links only configured Switch outputs from the keyboard at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await addCsrfCookie(context);
    const node = (id: string) => ({
      id,
      definition: { key: 'core.set', version: 1 },
      configVersion: 1,
      position: { x: id === 'switch' ? 80 : 400, y: 80 },
      config: {},
      inputMappings: {},
      connectionRefs: {},
    });
    const remote = remoteDraft({
      nodes: [
        {
          ...node('switch'),
          label: 'Choose branch',
          definition: { key: 'core.switch', version: 1 },
          config: { cases: [{ id: 'case-01', equals: 'ready' }] },
        },
        node('target'),
      ],
      edges: [],
      settings: {},
    });
    const switchDefinition =
      platformBrowserNodeDefinitionCatalog().definitions.find(
        (item) => item.definition.key === 'core.switch',
      );
    await installEditorRoutes(page, remote, {
      definitions: [definition, switchDefinition],
    });
    await page.goto(editorUrl);
    await page.getByTestId('rf__node-target').click();
    if (width < 1024)
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Step', exact: true })
        .click();
    await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
    await page
      .getByRole('button', { name: 'Link a step', exact: true })
      .press('Enter');
    await page.getByLabel('Link from step', { exact: true }).press('Enter');
    await page
      .getByRole('option', { name: 'Choose branch', exact: true })
      .press('Enter');
    await page.getByLabel('From output', { exact: true }).press('Enter');
    await expect(
      page.getByRole('option', { name: 'case-02', exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole('option', { name: 'case-01', exact: true })
      .press('Enter');
    await page.getByLabel('Into input', { exact: true }).press('Enter');
    await page.getByRole('option', { name: 'in', exact: true }).press('Enter');
    await page
      .getByRole('button', { name: 'Link', exact: true })
      .press('Enter');
    await expect
      .poll(() =>
        parseWorkflowGraphDraft(remote.graph).edges.map(
          (edge) => edge.source.port,
        ),
      )
      .toEqual(['case-01']);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
