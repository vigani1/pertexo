import type { JsonValue } from '@pertexo/workflow-model';
import { JsonataEvaluator } from '@pertexo/workflow-model/server';
import { platformBrowserNodeDefinitionCatalog } from '../../../../../packages/node-catalog/dist/index.js';
import { expect, test, type Locator, type Page } from '../../support/fixtures';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workspaceId,
  type RemoteDraft,
} from '../support';

const STEP_KEYS = ['core.condition', 'core.manual', 'core.set'];
const definitions = platformBrowserNodeDefinitionCatalog().definitions.filter(
  ({ definition }) => STEP_KEYS.includes(definition.key),
);

const FETCHED = { status: 200, customer: { name: 'Ada', tier: { level: 3 } } };

function node(
  id: string,
  key: string,
  label: string,
  { x, inputMappings = {} }: Readonly<{ x: number; inputMappings?: unknown }>,
) {
  return {
    id,
    label,
    definition: { key, version: 1 },
    position: { x, y: 80 },
    configVersion: 1,
    config: {},
    inputMappings,
    connectionRefs: {},
  };
}

function edge(source: string, target: string, port = 'out') {
  return {
    id: `${source}-${target}`,
    source: { nodeId: source, port },
    target: { nodeId: target, port: 'in' },
  };
}

/** Start, Fetch order, then a Condition and, one step further, Send note. */
function journeyGraph() {
  return {
    nodes: [
      node('manual', 'core.manual', 'Start', { x: 40 }),
      node('fetch', 'core.set', 'Fetch order', { x: 280 }),
      node('check', 'core.condition', 'Check order', { x: 520 }),
      node('send', 'core.set', 'Send note', {
        x: 760,
        inputMappings: {
          greeting: {
            kind: 'expression',
            language: 'jsonata',
            expression: '"a" &  & "b"',
          },
        },
      }),
    ],
    edges: [
      edge('manual', 'fetch'),
      edge('fetch', 'check'),
      edge('check', 'send', 'true'),
    ],
    settings: {},
  };
}

async function installJourney(page: Page, remote: RemoteDraft) {
  await installEditorRoutes(page, remote, { definitions });
  const draft = `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`;
  await page.route(`${draft}/steps/*/runs?**`, (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route(`${draft}/draft/nodes/fetch/sample`, (route) =>
    route.fulfill({
      json: {
        sample: {
          id: '11111111-1111-4111-8111-111111111111',
          nodeId: 'fetch',
          binding: 'sample-binding',
          state: 'pinned',
          source: { kind: 'json' },
          createdAt: '2026-10-16T10:00:00.000Z',
          expiresAt: '2026-11-15T10:00:00.000Z',
        },
        output: FETCHED,
        draftRevision: remote.revision,
        limits: { inlineBytes: 262144, depth: 64, members: 10000 },
      },
    }),
  );
}

/** Only the keyboard: Tab until the control has focus, or fail. */
async function tabTo(
  page: Page,
  target: Locator,
  key: 'Tab' | 'Shift+Tab' = 'Tab',
) {
  await expect(target).toBeAttached();
  for (let presses = 0; presses < 120; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement))
      return;
    await page.keyboard.press(key);
  }
  throw new Error(`Tab never reached ${target.toString()}`);
}

async function enterOn(page: Page, target: Locator) {
  await tabTo(page, target);
  await page.keyboard.press('Enter');
}

async function expectNoSidewaysScroll(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
}

/** Selects a step from the canvas and shows its panel on any width. */
async function openStep(page: Page, nodeId: string, width: number) {
  await enterOn(page, page.getByTestId(`rf__node-${nodeId}`));
  if (width < 1024)
    await enterOn(
      page,
      page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Step', exact: true }),
    );
}

async function expectPickerOnScreen(page: Page, width: number) {
  const box = await page
    .getByRole('dialog', { name: 'Insert data' })
    .boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? width + 1)).toBeLessThanOrEqual(width);
}

function conditionOf(remote: RemoteDraft) {
  const check = remote.graph.nodes.find(
    (candidate) => (candidate as { id: string }).id === 'check',
  ) as { inputMappings: Record<string, { expression?: string }> } | undefined;
  return check?.inputMappings.condition?.expression;
}

function greetingOf(remote: RemoteDraft) {
  const send = remote.graph.nodes.find(
    (candidate) => (candidate as { id: string }).id === 'send',
  ) as { inputMappings: Record<string, { expression?: string }> } | undefined;
  return send?.inputMappings.greeting?.expression;
}

const evaluator = new JsonataEvaluator();
test.afterAll(() => evaluator.shutdown());

const answerFor = (expression: string | undefined, fetched: JsonValue) =>
  evaluator.evaluate({
    expression: expression ?? '',
    context: { runInput: {}, nodeOutputs: { fetch: fetched } },
  });

for (const width of [1440, 320]) {
  test(`builds Condition rules and inserts data by keyboard alone at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await addCsrfCookie(context);
    const remote = remoteDraft(journeyGraph());
    await installJourney(page, remote);

    await page.goto(editorUrl);
    await openStep(page, 'check', width);
    const rules = page.getByRole('region', { name: 'Condition', exact: true });
    await expect(rules.getByLabel('Field', { exact: true })).toBeVisible();
    await expectNoSidewaysScroll(page);

    // Field: open the picker with Enter, Tab through it, open a nested
    // section, and pick. The first rule stays a plain equals.
    await enterOn(page, rules.getByLabel('Field', { exact: true }));
    const picker = page.getByRole('dialog', { name: 'Insert data' });
    await expect(picker).toBeVisible();
    await expectPickerOnScreen(page, width);
    await expectNoSidewaysScroll(page);
    const tier = picker.getByRole('button', {
      name: 'Show the fields in tier',
    });
    await enterOn(page, tier);
    await expect(
      picker.getByRole('button', { name: 'Hide the fields in tier' }),
    ).toHaveAttribute('aria-expanded', 'true');
    await enterOn(page, picker.getByRole('button', { name: /^level/u }));
    await expect(picker).toBeHidden();
    await expect(rules.getByLabel('Field', { exact: true })).toHaveText(
      /Fetch order · customer\.tier\.level/u,
    );

    // A number field starts at is greater than; choose is at least instead.
    const comparison = rules.getByLabel('Comparison', { exact: true });
    await expect(comparison).toHaveText(/is greater than/u);
    await enterOn(page, comparison);
    await page
      .getByRole('option', { name: 'is at least', exact: true })
      .press('Enter');
    await tabTo(page, rules.getByLabel('Value', { exact: true }));
    await page.keyboard.type('5');
    await expect.poll(() => conditionOf(remote)).toBeDefined();
    await expect(
      answerFor(conditionOf(remote), FETCHED),
    ).resolves.toMatchObject({ value: false });

    // A second rule: focus lands on its Field, and Any flips the real answer.
    await enterOn(page, rules.getByRole('button', { name: 'Add rule' }));
    const second = rules.getByLabel('Field', { exact: true }).nth(1);
    await expect(second).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(picker).toBeVisible();
    await enterOn(page, picker.getByRole('button', { name: /^name\s*Ada/u }));
    await expect(second).toHaveText(/Fetch order · customer\.name/u);
    await tabTo(page, rules.getByLabel('Value', { exact: true }).nth(1));
    await page.keyboard.type('ada');
    await expect.poll(() => conditionOf(remote)).toContain(') and (');
    await expect(
      answerFor(conditionOf(remote), FETCHED),
    ).resolves.toMatchObject({ value: false });

    // The switch is one Tab stop: reach the side that's on, then arrow across.
    await tabTo(
      page,
      rules.getByRole('button', { name: 'All must match' }),
      'Shift+Tab',
    );
    await page.keyboard.press('ArrowRight');
    await expect(
      rules.getByRole('button', { name: 'Any can match' }),
    ).toBeFocused();
    await page.keyboard.press('Space');
    await expect.poll(() => conditionOf(remote)).toContain(') or (');
    await expect(
      answerFor(conditionOf(remote), FETCHED),
    ).resolves.toMatchObject({ value: true });
    await expectNoSidewaysScroll(page);

    // Removing a rule hands focus to Add rule.
    await enterOn(page, rules.getByRole('button', { name: 'Remove rule 2' }));
    await expect(rules.getByRole('button', { name: 'Add rule' })).toBeFocused();
    await expect.poll(() => conditionOf(remote)).not.toContain(') or (');

    // Insert data, starting over from the saved draft.
    await page.goto(editorUrl);
    await openStep(page, 'send', width);
    // Tabs share one Tab stop: Tab to the open one, then arrow across.
    await tabTo(page, page.getByRole('tab', { name: 'Setup', exact: true }));
    const inputsTab = page.getByRole('tab', { name: 'Inputs', exact: true });
    for (let moved = 0; moved < 4; moved += 1) {
      if (await inputsTab.evaluate((tab) => tab === document.activeElement))
        break;
      await page.keyboard.press('ArrowRight');
    }
    await expect(inputsTab).toBeFocused();
    await page.keyboard.press('Enter');
    await enterOn(page, page.getByRole('button', { name: /^greeting/u }));
    const box = page.getByLabel('Expression', { exact: true });
    await tabTo(page, box);
    await page.keyboard.press('Home');
    for (let moved = 0; moved < 6; moved += 1)
      await page.keyboard.press('ArrowRight');
    await enterOn(page, page.getByRole('button', { name: 'Insert data' }));
    await expect(picker).toBeVisible();
    await expectPickerOnScreen(page, width);
    await expectNoSidewaysScroll(page);

    // Fetch order is one step too far back to be a step output.
    const further = picker.getByRole('button', {
      name: 'Fetch order',
      exact: true,
    });
    await expect(further).toHaveAttribute('aria-expanded', 'false');
    await enterOn(page, further);
    await expect(further).toHaveAttribute('aria-expanded', 'true');
    await expect(
      picker.getByText('Values from its pinned sample'),
    ).toBeVisible();
    await enterOn(page, picker.getByRole('button', { name: /^status\s*200/u }));
    await expect(box).toHaveValue('"a" & nodeOutputs."fetch"."status" & "b"');
    await expect
      .poll(() => greetingOf(remote))
      .toBe('"a" & nodeOutputs."fetch"."status" & "b"');
    await expect(answerFor(greetingOf(remote), FETCHED)).resolves.toMatchObject(
      { value: 'a200b' },
    );

    // A step with nothing to read offers its own test, one keypress away.
    await enterOn(page, page.getByRole('button', { name: 'Insert data' }));
    await expect(picker.getByText('No test data yet.').first()).toBeVisible();
    await enterOn(
      page,
      picker.getByRole('button', {
        name: 'Test Check order to see its fields',
      }),
    );
    await expect(
      page.getByRole('tab', { name: 'Test', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await expectNoSidewaysScroll(page);
  });
}
