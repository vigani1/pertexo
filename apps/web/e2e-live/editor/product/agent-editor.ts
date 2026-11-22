import { expect, type Page } from '@playwright/test';
import {
  addSingleStep,
  readEditorDraft,
} from '../../support/authoring/single-step';

export async function choose(page: Page, label: string, option: string) {
  await page.getByLabel(label, { exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

export async function addAgent(
  page: Page,
  path: string,
  label = 'Look up an order',
) {
  await addSingleStep(page, path, /^Manual start\b/u, 'Start');
  await page.getByRole('button', { name: 'Step actions', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Add step after', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Add a step after “Start”' })
    .getByRole('button', { name: /^Agent\b/u })
    .click();
  await expect
    .poll(async () => (await readEditorDraft(page, path)).graph.edges.length)
    .toBe(1);
  const { graph } = await readEditorDraft(page, path);
  const agent = graph.nodes.find(
    ({ definition }) => definition.key === 'ai.agent',
  );
  if (agent === undefined) throw new Error('Browser-authored Agent is missing');
  await page.getByTestId(`rf__node-${agent.id}`).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Label', { exact: true }).fill(label);
  await page.keyboard.press('Tab');
}
