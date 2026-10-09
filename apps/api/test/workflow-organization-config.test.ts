import { describe, expect, it } from 'vitest';

import { parseApiConfig } from '../src/platform/config/api-config.js';
import { parseWorkflowOrganizationConfig } from '../src/platform/config/workflow-organization-config.js';

const key = Buffer.from(
  Array.from({ length: 32 }, (_, index) => index),
).toString('base64');
const baseEnvironment = {
  DATABASE_URL: 'postgresql://pertexo_app:synthetic@localhost:5432/pertexo',
};

describe('workflow organization cursor configuration', () => {
  it('leaves only the new capability absent with no identity-secret fallback', () => {
    expect(parseWorkflowOrganizationConfig({})).toBeUndefined();
    expect(
      parseWorkflowOrganizationConfig({ INVITATION_TOKEN_KEY: key }),
    ).toBeUndefined();
    expect(parseApiConfig(baseEnvironment)).not.toHaveProperty(
      'workflowOrganization',
    );
  });

  it('uses one stable dedicated key across independently parsed API instances', () => {
    const environment = {
      ...baseEnvironment,
      WORKFLOW_ORGANIZATION_CURSOR_KEY: key,
    };
    const first = parseApiConfig(environment).workflowOrganization;
    const second = parseApiConfig(environment).workflowOrganization;
    expect(first).toEqual({ cursorSigningKey: key });
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it.each([
    '',
    'secret-input-must-not-appear-in-error',
    Buffer.alloc(31).toString('base64'),
    Buffer.alloc(33).toString('base64'),
    key.replace(/=$/u, ''),
    `${key}\n`,
    ` ${key}`,
    // Alternate final sextet decodes to the same bytes but is not canonical.
    `${key.slice(0, -2)}9=`,
    key.replaceAll('+', '-').replaceAll('/', '_') + '=',
  ])('sanitizes malformed/incorrectly sized key %#', (value) => {
    let error: unknown;
    try {
      parseApiConfig({
        ...baseEnvironment,
        WORKFLOW_ORGANIZATION_CURSOR_KEY: value,
      });
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: 'Workflow organization configuration is invalid',
    });
    expect(error).not.toHaveProperty('cause');
  });

  it.each([
    { WORKFLOW_ORGANIZATION_CURSOR_KEY_VERSION: 'v1' },
    {
      WORKFLOW_ORGANIZATION_CURSOR_KEY: key,
      WORKFLOW_ORGANIZATION_CURSOR_PREVIOUS_KEYS: '[]',
    },
  ])(
    'fails closed for partial or unrecognized capability configuration %#',
    (extra) => {
      expect(() => parseApiConfig({ ...baseEnvironment, ...extra })).toThrow(
        'Workflow organization configuration is invalid',
      );
    },
  );

  it.each(['INVITATION_TOKEN_KEY', 'AUTH_MAIL_KEY', 'BETTER_AUTH_SECRET'])(
    'rejects direct reuse of %s',
    (name) => {
      expect(() =>
        parseWorkflowOrganizationConfig({
          [name]: key,
          WORKFLOW_ORGANIZATION_CURSOR_KEY: key,
        }),
      ).toThrow('Workflow organization configuration is invalid');
    },
  );

  it('rejects equivalent key bytes and previous identity key material', () => {
    expect(() =>
      parseWorkflowOrganizationConfig({
        WORKFLOW_ORGANIZATION_CURSOR_KEY: key,
        INVITATION_TOKEN_KEY: key.slice(0, -1),
      }),
    ).toThrow('Workflow organization configuration is invalid');
    expect(() =>
      parseWorkflowOrganizationConfig(
        {
          WORKFLOW_ORGANIZATION_CURSOR_KEY: key,
        },
        [key],
      ),
    ).toThrow('Workflow organization configuration is invalid');
    expect(() =>
      parseApiConfig({
        ...baseEnvironment,
        BETTER_AUTH_SECRET: 'synthetic-identity-secret-at-least-32-characters',
        PUBLIC_WEB_ORIGIN: 'http://localhost:5173',
        INVITATION_TOKEN_KEY: Buffer.alloc(32, 9).toString('base64'),
        INVITATION_TOKEN_KEY_VERSION: 'v2',
        INVITATION_TOKEN_PREVIOUS_KEYS: JSON.stringify([
          { version: 'v1', key },
        ]),
        WORKFLOW_ORGANIZATION_CURSOR_KEY: key,
      }),
    ).toThrow('Workflow organization configuration is invalid');
  });
});
