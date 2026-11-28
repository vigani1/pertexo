import type { Locator, Page } from '@playwright/test';
import {
  editorUrl,
  workflowId,
  workspaceId,
} from '../../workflow-editor/support';
import { showInboxArrival } from '../polish-layout-fixture';
import {
  form,
  formId,
  requestId,
  reviewId,
  succeededRunId,
  taskId,
} from './activity-data';
import { connections, tables } from './workspace-data';

type Screen = Readonly<{
  name: string;
  path: string;
  /** What shows once the page's reads have answered. */
  ready: (page: Page) => Locator;
  /** Pages shown before anyone signs in. */
  signedOut?: boolean;
  prepare?: (page: Page) => Promise<void>;
  open?: (page: Page) => Promise<void>;
}>;

const root = `/w/${workspaceId}`;
const hub = editorUrl.replace(/\/$/u, '');
const heading = (name: string | RegExp) => (page: Page) =>
  page.getByRole('heading', { name }).first();

export const workspaceScreens: readonly Screen[] = [
  {
    name: 'home',
    path: root,
    ready: (page) =>
      heading(
        (page.viewportSize()?.width ?? 1280) < 768 ? 'Today' : 'The last hour',
      )(page),
  },
  { name: 'workflows', path: `${root}/workflows`, ready: heading('Workflows') },
  { name: 'runs', path: `${root}/runs`, ready: heading('Runs') },
  {
    name: 'run-detail',
    path: `${root}/runs/${succeededRunId}`,
    ready: heading(/Succeeded in/u),
  },
  {
    name: 'inbox-arrival',
    path: root,
    open: async (page) => {
      await showInboxArrival(page);
    },
    ready: (page) => page.getByRole('dialog', { name: 'Nightly import' }),
  },
  { name: 'inbox', path: `${root}/inbox`, ready: heading('Inbox') },
  {
    name: 'build',
    path: hub,
    ready: (page) => page.getByTestId('rf__node-start'),
  },
  {
    name: 'step-inspector',
    path: hub,
    open: async (page) => {
      const width = page.viewportSize()?.width ?? 1280;
      const step = page.getByTestId('rf__node-extract');
      if (width <= 1024) await step.tap();
      else await step.click();
      if (width < 1024) {
        await page
          .getByRole('navigation', { name: 'Editor panels' })
          .getByRole('button', { name: 'Step', exact: true })
          .tap();
      }
    },
    ready: (page) => page.getByRole('tab', { name: 'Setup', exact: true }),
  },
  {
    name: 'workflow-runs',
    path: `${hub}/runs`,
    ready: (page) =>
      page.getByRole('navigation', { name: 'Workflow sections' }),
  },
  {
    name: 'workflow-comments',
    path: `${hub}/comments`,
    ready: heading('Comments'),
  },
  { name: 'approvals', path: `${root}/approvals`, ready: heading('Inbox') },
  { name: 'requests', path: `${root}/requests`, ready: heading('Inbox') },
  {
    name: 'approval-detail',
    path: `${root}/approvals/${taskId}`,
    ready: heading('Review invoice'),
  },
  {
    name: 'request-detail',
    path: `${root}/requests/${requestId}`,
    ready: heading('Complete invoice reference'),
  },
  {
    name: 'publication-review',
    path: `${root}/publish-reviews/${reviewId}`,
    ready: heading('Publication review'),
  },
  {
    name: 'variables',
    path: `${root}/settings/variables`,
    ready: heading(/variables/iu),
  },
  {
    name: 'usage-trends',
    path: `${root}/settings/usage/trends`,
    ready: heading('Trends'),
  },
  {
    name: 'account-security',
    path: '/account/security',
    ready: (page) => page.getByRole('heading', { level: 1 }),
  },
  {
    name: 'public-form',
    path: `/forms/${formId}#${'a'.repeat(43)}`,
    signedOut: true,
    open: async (page) => {
      await page
        .getByLabel('Your company', { exact: true })
        .fill('Fjord Supplies');
      await page.getByLabel('Invoice number', { exact: true }).fill('INV-2318');
      await page.getByLabel('Currency', { exact: true }).selectOption('EUR');
      await page.getByLabel('Amount', { exact: true }).fill('7480');
    },
    ready: heading(form.title),
  },
  {
    name: 'member-form',
    path: `${root}/forms/${workflowId}`,
    ready: heading(form.title),
  },
  {
    name: 'command-palette',
    path: root,
    open: async (page) => {
      await heading('The last hour')(page).waitFor();
      await page.keyboard.press('Control+k');
    },
    ready: (page) => page.getByRole('dialog', { name: 'Search Pertexo' }),
  },
  {
    name: 'create-workflow',
    path: `${root}/workflows?create=true`,
    ready: (page) => page.getByRole('dialog', { name: /New workflow/u }),
  },
  {
    name: 'sign-up',
    path: '/sign-up',
    signedOut: true,
    ready: heading(/account/iu),
  },
  {
    name: 'forgot-password',
    path: '/forgot-password',
    signedOut: true,
    ready: heading(/password/iu),
  },
  {
    name: 'reset-password',
    path: '/reset-password',
    signedOut: true,
    ready: heading(/password|link/iu),
  },
  {
    name: 'invitation',
    path: '/invitations/accept',
    signedOut: true,
    ready: heading(/invit/iu),
  },
  {
    name: 'unsubscribe',
    path: `/notifications/unsubscribe#${'a'.repeat(43)}`,
    signedOut: true,
    ready: heading('Turn off personal email?'),
  },
  {
    name: 'outside-not-found',
    path: '/missing-page',
    signedOut: true,
    ready: heading(/doesn’t exist/u),
  },

  {
    name: 'triggers',
    path: `${hub}/triggers`,
    ready: (page) => page.getByRole('article', { name: 'By hand' }),
  },
  {
    name: 'versions',
    path: `${hub}/versions`,
    ready: (page) => page.getByRole('navigation', { name: 'Versions' }),
  },
  {
    name: 'versions-detail',
    path: `${hub}/versions`,
    open: async (page) => {
      await page
        .getByRole('navigation', { name: 'Versions' })
        .getByRole('button', { name: /^v2\b/u })
        .click();
    },
    ready: heading(/^v2$/u),
  },
  {
    name: 'workflow-settings',
    path: `${hub}/settings`,
    ready: heading('Danger zone'),
  },
  {
    name: 'connections',
    path: `${root}/connections`,
    ready: (page) => page.getByRole('list', { name: 'Connections' }),
  },
  {
    name: 'connections-many',
    path: `${root}/connections?connection=${connections[0]?.id ?? ''}`,
    open: async (page) => {
      await page.getByRole('button', { name: 'Show all 12 workflows' }).click();
    },
    ready: heading('All 12 workflows'),
  },
  {
    name: 'tables',
    path: `${root}/data-tables`,
    ready: (page) => page.getByRole('navigation', { name: 'Tables' }),
  },
  {
    name: 'table-detail',
    path: `${root}/data-tables/${tables[0]?.id ?? ''}`,
    ready: heading('Restock thresholds'),
  },
  {
    name: 'team',
    path: `${root}/team`,
    ready: (page) => page.getByRole('list', { name: 'Builders' }),
  },
  {
    name: 'team-invite',
    path: `${root}/team`,
    open: async (page) => {
      await page.getByRole('button', { name: 'Invite people' }).click();
    },
    ready: (page) => page.getByRole('dialog', { name: 'Invite people' }),
  },
  {
    name: 'settings',
    path: `${root}/settings`,
    ready: heading('Automatic pause'),
  },
  {
    name: 'usage',
    path: `${root}/settings/usage`,
    ready: heading('By workflow'),
  },
  { name: 'alerts', path: `${root}/settings/alerts`, ready: heading('Alerts') },
  {
    name: 'audit',
    path: `${root}/settings/audit`,
    ready: heading('Audit log'),
  },
  {
    name: 'account',
    path: `${root}/account`,
    ready: heading('How you sign in'),
  },
  {
    name: 'account-edit-email',
    path: `${root}/account`,
    open: async (page) => {
      await page.getByRole('button', { name: 'Change email' }).click();
    },
    ready: (page) => page.getByRole('dialog', { name: 'Change email' }),
  },
  {
    name: 'account-sessions',
    path: `${root}/account`,
    ready: (page) => page.getByText('This device', { exact: true }),
  },
  {
    name: 'audit-calendar',
    path: `${root}/settings/audit`,
    ready: (page) =>
      page.getByRole('button', { name: 'Yesterday', exact: true }),
  },
  {
    name: 'notifications',
    path: `${root}/settings/notifications`,
    ready: heading('Notifications'),
  },
  {
    name: 'api-tokens',
    path: `${root}/settings/api-tokens`,
    ready: heading('Build runner'),
  },
  {
    name: 'promotion',
    path: `${root}/settings/promotion`,
    ready: heading('Promotion'),
  },
  { name: 'sso', path: `${root}/settings/sso`, ready: heading(/sign-on/u) },
  {
    name: 'sign-in',
    path: '/login',
    signedOut: true,
    ready: (page) => page.getByRole('button', { name: /Sign in/u }).first(),
  },
  {
    name: 'workspaces',
    path: '/workspaces',
    ready: (page) => page.getByText('Control Operations').first(),
  },
  {
    name: 'workspace-forbidden',
    path: '/workspaces',
    prepare: async (page) => {
      await page.route('**/v1/workspaces?**', (route) =>
        route.fulfill({
          status: 403,
          contentType: 'application/problem+json',
          json: {
            code: 'workspace.forbidden',
            title: 'Forbidden',
            type: 'about:blank',
            status: 403,
            requestId: 'request-forbidden',
          },
        }),
      );
    },
    ready: (page) => page.getByText('403 · Held at the door', { exact: true }),
  },
  {
    name: 'workspace-offline',
    path: '/workspaces',
    prepare: async (page) => {
      await page.route('**/v1/workspaces?**', (route) =>
        route.abort('internetdisconnected'),
      );
    },
    ready: (page) =>
      page.getByText('Offline · Reaching for the server', { exact: true }),
  },
  {
    name: 'workspace-unavailable',
    path: '/w/11000000-0000-4000-8000-000000000099',
    ready: heading('This workspace isn’t available'),
  },
  {
    name: 'not-found',
    path: `${root}/nowhere`,
    ready: (page) => page.getByText(`${root}/nowhere`, { exact: true }),
  },
];
