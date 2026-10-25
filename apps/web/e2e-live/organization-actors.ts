import {
  accessibleWorkspacesResponseSchema,
  workspaceInvitationCommandResponseSchema,
} from '@pertexo/contracts';
import type { DelegatedRole } from '@pertexo/workflow-model';
import {
  expect,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';
import { registerEditorUser } from './support/ordinary-editor-session';
import { command } from './workflow-organization/fixture';
export async function invitedActor(input: {
  browser: Browser;
  owner: Page;
  request: APIRequestContext;
  mailOrigin: string;
  workspaceId: string;
  role: DelegatedRole;
}) {
  const context = await input.browser.newContext({
    baseURL: new URL(input.owner.url()).origin,
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const email = await registerEditorUser(
      page,
      input.request,
      input.mailOrigin,
      `Organization ${input.role}`,
    );
    await input.owner.goto(`/w/${input.workspaceId}/team`);
    await input.owner
      .getByRole('button', { name: 'Invite people', exact: true })
      .click();
    const sheet = input.owner.getByRole('dialog', {
      name: 'Invite people',
      exact: true,
    });
    await sheet.getByLabel('Email addresses', { exact: true }).fill(email);
    await sheet.getByLabel('Email addresses', { exact: true }).press('Enter');
    const role = sheet.getByRole('combobox', { name: 'Role', exact: true });
    await role.focus();
    await input.owner.keyboard.press('ArrowDown');
    await input.owner
      .getByRole('option', {
        name: new RegExp(
          `^${input.role[0]?.toUpperCase() ?? ''}${input.role.slice(1)} `,
          'u',
        ),
      })
      .click();
    const response = await command({
      page: input.owner,
      button: sheet.getByRole('button', {
        name: 'Send invitation',
        exact: true,
      }),
      suffix: '/invitations',
      status: 202,
    });
    const invitation = workspaceInvitationCommandResponseSchema.parse(
      await response.json(),
    ).invitation;
    const delivered = await input.request.post(
      `${input.mailOrigin}/invitation-delivery`,
      { data: { workspaceId: input.workspaceId, invitationId: invitation.id } },
    );
    expect(delivered.status()).toBe(200);
    const value: unknown = await delivered.json();
    if (
      typeof value !== 'object' ||
      value === null ||
      !('path' in value) ||
      typeof value.path !== 'string'
    )
      throw new Error('Delivered invitation navigation unavailable');
    try {
      await page.goto(value.path);
    } catch {
      throw new Error(
        'Delivered invitation navigation failed; sensitive details omitted',
      );
    }
    const invitationAction = page.getByRole('button', {
      name: /^(Accept and open workspace|Sign in to accept)$/u,
    });
    await expect(invitationAction).toBeVisible();
    // Prove the account through ordinary sign-in AFTER this bound invitation
    // exists; a pre-invitation session is not treated as acceptance evidence.
    await page.goto('/logout?returnTo=%2Finvitations%2Faccept');
    await expect(page).toHaveURL((url) => url.pathname === '/login');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page
      .getByLabel('Password', { exact: true })
      .fill('a long enough integration password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL('/invitations/accept');
    await page
      .getByRole('button', { name: 'Accept and open workspace', exact: true })
      .click();
    await expect(page).toHaveURL(`/w/${input.workspaceId}`);
    const workspaces = await page.request.get('/v1/workspaces');
    expect(workspaces.status()).toBe(200);
    expect(
      accessibleWorkspacesResponseSchema
        .parse(await workspaces.json())
        .items.find((item) => item.id === input.workspaceId)?.role,
    ).toBe(input.role);
    await page.goto(`/w/${input.workspaceId}/workflows`);
    return { page, close: () => context.close() };
  } catch (cause) {
    await context.close();
    throw cause;
  }
}
