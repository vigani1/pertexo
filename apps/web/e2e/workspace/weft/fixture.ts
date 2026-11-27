import { installActivityRoutes, form, formId } from './activity-data';
import { AUTHENTICATION_PROVIDERS } from '@pertexo/workflow-model';
import { installSettingsRoutes } from './settings-data';
import type { Page } from '@playwright/test';
import {
  manualDefinition,
  definition,
  remoteDraft,
  user,
  workflowId,
  workspaceId,
} from '../../workflow-editor/support';
import { installPolishRoutes } from '../polish-layout-fixture';
import {
  connectionUsage,
  connections,
  invitations,
  members,
  tableQuotas,
  tableRows,
  tables,
} from './workspace-data';
import { installWorkflowTabRoutes, liveVersionId } from './workflow-data';

const workflowApi = `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`;

export async function installPublicScreenRoutes(page: Page) {
  await page.route('**/v1/auth/capabilities', (route) =>
    route.fulfill({
      json: {
        password: {
          enabled: true,
          minimumLength: 12,
          verificationRequired: true,
        },
        socialProviders: AUTHENTICATION_PROVIDERS,
        signUp: 'open',
      },
    }),
  );
  await installFormRoutes(page);
}

async function installFormRoutes(page: Page) {
  for (const path of [`**/v1/forms/${formId}`, `${workflowApi}/form`]) {
    await page.route(path, (route) =>
      route.fulfill({ json: { versionId: liveVersionId, form } }),
    );
  }
}

export async function installWorkspaceRoutes(page: Page) {
  const [start, extract, post] = [
    ['start', manualDefinition, 'By hand', 0],
    ['extract', definition, 'Read the invoice', 300],
    ['post', definition, 'Post to ERP', 600],
  ] as const;
  const nodes = [start, extract, post].map(([id, step, label, x]) => ({
    id,
    label,
    definition: step.definition,
    configVersion: 1,
    position: { x, y: 0 },
    config: {},
    inputMappings: {},
    connectionRefs: {},
  }));
  await installPolishRoutes(page, {
    draft: remoteDraft({
      nodes,
      edges: [
        {
          id: 'start-extract',
          source: { nodeId: start[0], port: 'out' },
          target: { nodeId: extract[0], port: 'in' },
        },
        {
          id: 'extract-post',
          source: { nodeId: extract[0], port: 'out' },
          target: { nodeId: post[0], port: 'in' },
        },
      ],
      settings: {},
    }),
    definitions: [definition, manualDefinition],
  });
  await installWorkflowTabRoutes(page);
  await installWorkspaceDataRoutes(page);
  await installSettingsRoutes(page);
  await installFormRoutes(page);
  await installActivityRoutes(page);
}

const workspaceApi = `**/v1/workspaces/${workspaceId}`;

async function installWorkspaceDataRoutes(page: Page) {
  await page.route(`${workspaceApi}/data-tables`, (route) =>
    route.fulfill({ json: { tables, quotas: tableQuotas } }),
  );
  await page.route(`${workspaceApi}/data-tables/*/rows/query`, (route) =>
    route.fulfill({ json: tableRows }),
  );
  await page.route(`${workspaceApi}/assistant`, (route) =>
    route.fulfill({ json: { selection: null } }),
  );
  await page.route(`${workspaceApi}/members?**`, (route) =>
    route.fulfill({ json: members(user.id) }),
  );
  await page.route(`${workspaceApi}/invitations?**`, (route) =>
    route.fulfill({ json: invitations }),
  );
  await page.route(`${workspaceApi}/connections?**`, (route) =>
    route.fulfill({ json: { items: connections, nextCursor: null } }),
  );
  await page.route(`${workspaceApi}/connections/*`, (route) =>
    route.fulfill({
      json:
        connections.find((item) => route.request().url().endsWith(item.id)) ??
        connections[0],
    }),
  );
  await page.route(`${workspaceApi}/connections/*/usage?**`, (route) =>
    route.fulfill({ json: connectionUsage }),
  );
}
