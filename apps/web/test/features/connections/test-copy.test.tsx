import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ConnectionDefinitionsContext } from '@/features/catalog/hooks/connection-definitions';
import { ConnectionTestPanel } from '@/features/connections/components/connection-test/panel';
import {
  describeConnectionHealth,
  describeTestOutcome,
} from '@/features/connections/model/connection-health';
import { browserConnectionDefinitions } from '../../support/fixtures/node-catalog';

it.each(browserConnectionDefinitions)(
  'preserves the $authType test and health copy',
  (definition) => {
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
    expect({
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
    }).toMatchSnapshot();
  },
);
