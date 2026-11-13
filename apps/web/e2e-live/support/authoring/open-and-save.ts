import { expect, type Page } from '@playwright/test';
import { workflowDraftResponseSchema } from '@pertexo/contracts';

async function readDraft(page: Page, workspaceId: string, workflowId: string) {
  const response = await page.request.get(
    `/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`,
  );
  expect(response.status()).toBe(200);
  return workflowDraftResponseSchema.parse(await response.json());
}

// Text a person can type into: number and text fields, rule and
// schedule builders. Choices, switches, the label and the hidden inputs
// that carry a choice's value are left out.
const TYPED_FIELDS = [
  'input:not([type])',
  'input[type="text"]',
  'input[type="url"]',
  'textarea',
]
  .map(
    (kind) =>
      `${kind}:enabled:not([aria-hidden="true"]):not([id*="hidden-input"])`,
  )
  .join(', ');

// The settings each curated step stores that the generic form draws, by
// field name. The walk waits for each to be drawn and must retype each,
// so it can't pass by reaching none of them.
const DRAWN_SETTINGS: Readonly<Record<string, readonly string[]>> = {
  'http.request': [
    'config.url',
    'config.timeoutMillis',
    'config.maxRedirects',
    'config.maxResponseBytes',
    'config.inlineResponseBytes',
  ],
  'slack.send_message': ['config.timeoutMillis'],
};

/**
 * Opening a saved example and saving it must not change what it stores.
 * Every step's setup is opened with its folded groups unfolded, and every
 * typed field is retyped to exactly what it shows (a space typed and
 * taken back, so the page sees an edit). A field whose shown text doesn't
 * read back as its stored value saves a different setup or turns invalid.
 * The workflow is then saved twice (a label set and cleared), and the
 * stored graph, every step's setup included, must be what it was.
 * Returns the fields retyped in each step, by name.
 */
export async function openEveryStepAndSave(
  page: Page,
  workspaceId: string,
  workflowId: string,
) {
  await page.goto(`/w/${workspaceId}/workflows/${workflowId}`);
  const before = await readDraft(page, workspaceId, workflowId);
  const panel = page.getByRole('complementary', { name: 'Step panel' });
  const visited: Record<string, string[]> = {};
  for (const node of before.graph.nodes) {
    await page.getByTestId(`rf__node-${node.id}`).focus({ timeout: 10_000 });
    await page.keyboard.press('Enter');
    await expect(panel).toBeVisible();
    await panel
      .getByRole('tab', { name: 'Setup', exact: true })
      .click({ timeout: 10_000 });
    const content = panel.getByRole('tabpanel').filter({ visible: true });
    const drawn = DRAWN_SETTINGS[node.definition.key] ?? [];
    // Unfold each folded group on screen; one inside another shows once
    // its outer group is open.
    if (drawn.length > 0)
      await expect(content.locator(`[name="${drawn[0] ?? ''}"]`)).toBeVisible();
    const folded = content
      .locator('details:not([open]) > summary')
      .filter({ visible: true });
    for (let round = 0; round < 5 && (await folded.count()) > 0; round += 1)
      for (const summary of await folded.all())
        await summary.click({ timeout: 10_000 });
    for (const name of drawn)
      await expect(content.locator(`[name="${name}"]`)).toBeVisible();
    const names: string[] = [];
    // Each field by its own id: retyping one may redraw the others, so a
    // position in the list would not stay on the same field.
    const ids = await content
      .locator(TYPED_FIELDS)
      .filter({ visible: true })
      .evaluateAll((fields) => fields.map((field) => field.id));
    expect(ids, `${node.id} typed fields without an id`).not.toContain('');
    for (const id of ids) {
      const field = content.locator(`[id="${id}"]`);
      const shown = await field.inputValue({ timeout: 10_000 });
      const name = (await field.getAttribute('name')) ?? id;
      await field.focus({ timeout: 10_000 });
      // The caret goes after the text (tabbing in selects it all, and End
      // doesn't move the caret on every platform).
      await field.evaluate((input: HTMLInputElement) => {
        input.setSelectionRange(input.value.length, input.value.length);
      });
      await page.keyboard.type(' ');
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Tab');
      await expect(field, `${node.id} ${name}: “${shown}”`).toHaveValue(shown);
      await expect(field, `${node.id} ${name}: “${shown}”`).not.toHaveAttribute(
        'aria-invalid',
        'true',
      );
      names.push(name);
    }
    expect(names, `${node.id} retyped`).toEqual(
      expect.arrayContaining([...drawn]),
    );
    visited[node.id] = names;
  }
  const [first] = before.graph.nodes;
  if (first === undefined) throw new Error(`${workflowId} has no steps`);
  await page.getByTestId(`rf__node-${first.id}`).focus();
  await page.keyboard.press('Enter');
  const label = panel.getByLabel('Label', { exact: true });
  // An empty label stores none, so the second save restores the first.
  for (const [typed, stored] of [
    [`${first.label ?? 'Step'} (opened)`, `${first.label ?? 'Step'} (opened)`],
    [first.label ?? '', first.label],
  ] as const) {
    await label.fill(typed);
    await page.keyboard.press('Tab');
    await expect
      .poll(
        async () =>
          (await readDraft(page, workspaceId, workflowId)).graph.nodes.find(
            (node) => node.id === first.id,
          )?.label,
      )
      .toBe(stored);
  }
  const after = await readDraft(page, workspaceId, workflowId);
  expect(after.revision).toBeGreaterThanOrEqual(before.revision + 2);
  expect(after.graph).toEqual(before.graph);
  return visited;
}
