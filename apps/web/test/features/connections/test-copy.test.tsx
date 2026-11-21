import type { ConnectionFormDefinition } from '@pertexo/contracts';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ConnectionDefinitionsContext } from '@/features/catalog/hooks/connection-definitions';
import { ConnectionTestPanel } from '@/features/connections/components/connection-test/panel';
import {
  describeConnectionHealth,
  describeTestOutcome,
} from '@/features/connections/model/connection-health';
import { browserConnectionDefinitions } from '../../support/fixtures/node-catalog';

const LEGACY_AUTH_TYPES: readonly string[] = [
  'hmac_key',
  'http_headers',
  'oauth2',
  'postgres',
  'resend_api_key',
  'slack_bot_token',
  'smtp',
];

it.each(LEGACY_AUTH_TYPES.map((authType) => ({ authType })))(
  'preserves the $authType test and health copy',
  ({ authType }) => {
    const definition = browserConnectionDefinitions.find(
      (item) => item.authType === authType,
    );
    if (definition === undefined)
      throw new Error(`No ${authType} connection in the catalog`);
    expect(renderConnectionCopy(definition)).toMatchSnapshot();
  },
);

for (const definition of browserConnectionDefinitions) {
  if (LEGACY_AUTH_TYPES.includes(definition.authType)) continue;

  it(`renders test and health copy for ${definition.authType}`, () => {
    const copy = renderConnectionCopy(definition);
    const { presentation } = definition;
    const name = presentation.testCopy?.name ?? presentation.name;
    const credential =
      presentation.testCopy?.credential ?? presentation.credential;

    expect(copy.action.trim()).toBeTruthy();
    expect(copy.panel).toContain(name);
    expect(copy.ok.title).toContain(name);
    expect(copy.rejected.title).toContain(credential);
    expect(copy.health.text).toContain(credential);
  });
}

function renderConnectionCopy(definition: ConnectionFormDefinition) {
  const { providerKey, authType } = definition;
  const rejected = {
    ok: false,
    httpStatus: 403,
    errorCode: 'connection.credential_rejected',
  } as const;
  const { container } = render(
    <ConnectionDefinitionsContext value={browserConnectionDefinitions}>
      <ConnectionTestPanel
        provider={providerKey}
        authType={authType}
        test={{
          phase: 'idle',
          expired: false,
          error: undefined,
          result: undefined,
          startNewAttempt: () => undefined,
        }}
        onRun={() => undefined}
      />
    </ConnectionDefinitionsContext>,
  );
  return {
    panel: container.textContent,
    action: screen.getByRole('button').textContent,
    ok: describeTestOutcome(definition, {
      ok: true,
      httpStatus: 200,
      errorCode: null,
    }),
    rejected: describeTestOutcome(definition, rejected),
    health: describeConnectionHealth(
      {
        providerKey,
        status: 'reauthorization_required',
        updatedAt: '2026-09-24T11:00:00.000Z',
        health: {
          lastHealthyAt: null,
          lastTestedAt: null,
          lastErrorCode: rejected.errorCode,
        },
      },
      undefined,
      definition,
    ),
  };
}
