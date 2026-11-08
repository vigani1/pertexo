import jsonata from 'jsonata';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import { expect, test } from '../../support/fixtures';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
} from '../support';

for (const width of [375, 1280]) {
  for (const dynamic of [false, true]) {
    test(`duplicates ${dynamic ? 'dynamic' : 'static'} expression references at ${String(width)}px`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await addCsrfCookie(context);
      const expression = dynamic
        ? '$lookup(nodeOutputs, runInput.source).amount * 2'
        : 'nodeOutputs."source"."amount" * 2';
      const node = (id: string, label: string, x: number) => ({
        id,
        label,
        definition: { key: 'core.set', version: 1 },
        configVersion: 1,
        position: { x, y: 80 },
        config: { value: 'preserved' },
        inputMappings: {},
        connectionRefs: {},
      });
      const remote = remoteDraft({
        nodes: [
          node('source', 'Source', 80),
          {
            ...node('consumer', 'Consumer', 380),
            inputMappings: {
              amount: { kind: 'expression', language: 'jsonata', expression },
            },
          },
        ],
        edges: [
          {
            id: 'original-link',
            source: { nodeId: 'source', port: 'out' },
            target: { nodeId: 'consumer', port: 'in' },
          },
        ],
        settings: {},
      });
      await installEditorRoutes(page, remote);
      await page.goto(editorUrl);
      await page.getByTestId('rf__node-source').click();
      await page
        .getByTestId('rf__node-consumer')
        .click({ modifiers: ['ControlOrMeta'] });
      await expect(
        page.getByRole('toolbar', { name: 'Canvas selection' }),
      ).toContainText('2 steps');
      await page.keyboard.press('ControlOrMeta+d');
      if (dynamic)
        await expect(
          page.getByText(
            'Expressions that choose a step dynamically keep their original lookup. Review those expressions before running the copies.',
            { exact: true },
          ),
        ).toBeVisible();
      await expect.poll(() => remote.graph.nodes.length).toBe(4);
      const graph = parseWorkflowGraphDraft(remote.graph);
      const copiedSource = graph.nodes.find(
        (item) => item.id !== 'source' && item.label === 'Source',
      );
      const copiedConsumer = graph.nodes.find(
        (item) => item.id !== 'consumer' && item.label === 'Consumer',
      );
      const mapping = copiedConsumer?.inputMappings.amount;
      if (
        copiedSource === undefined ||
        copiedConsumer === undefined ||
        mapping?.kind !== 'expression'
      )
        throw new Error('Expected both copied steps and their expression');
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          source: { nodeId: copiedSource.id, port: 'out' },
          target: { nodeId: copiedConsumer.id, port: 'in' },
        }),
      );
      expect(
        await jsonata(mapping.expression).evaluate({
          nodeOutputs: {
            source: { amount: 1 },
            [copiedSource.id]: { amount: 100 },
          },
          runInput: { source: 'source' },
        }),
      ).toBe(dynamic ? 2 : 200);
      if (dynamic) expect(mapping.expression).toBe(expression);
      await expect(page).toHaveURL(editorUrl);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });
  }
}
