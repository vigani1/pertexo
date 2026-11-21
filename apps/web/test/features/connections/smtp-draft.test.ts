import { browserConnectionDefinitions } from '../../support/fixtures/node-catalog';
import { describe, expect, it } from 'vitest';
import {
  credentialErrors,
  emptyCredentialDraft,
  toCreateRequest,
  toConnectionCredential,
} from '@/features/connections/model/credential-draft';

const definition = browserConnectionDefinitions.find(
  (entry) => entry.authType === 'smtp',
);
if (definition === undefined)
  throw new Error('SMTP is missing from the catalog');

describe('SMTP connection form', () => {
  it('starts with required STARTTLS and identifies every missing required field', () => {
    const draft = emptyCredentialDraft(definition, () => 'row');
    expect(draft).toMatchObject({
      provider: 'schema',
      values: { security: 'starttls', port: '587' },
    });
    expect(credentialErrors(draft)).toMatchObject({
      host: expect.any(String) as unknown,
      username: expect.any(String) as unknown,
      password: expect.any(String) as unknown,
      fromEmail: expect.any(String) as unknown,
    });
  });
  it('preserves the exact password and saves a typed email connection', () => {
    const draft = {
      provider: 'schema' as const,
      definition,
      values: {
        host: 'smtp.example.test',
        port: '465',
        security: 'implicit' as const,
        username: 'ada',
        password: '  exact password  ',
        fromEmail: 'alerts@example.test',
        fromName: 'Workspace alerts',
      },
    };
    expect(credentialErrors(draft)).toEqual({});
    const credential = toConnectionCredential(draft);
    if (credential === undefined) throw new Error('Expected a valid draft');
    expect(toCreateRequest('Workspace mail', definition, credential)).toEqual({
      providerKey: 'email',
      name: 'Workspace mail',
      credential: {
        type: 'smtp',
        host: 'smtp.example.test',
        port: 465,
        security: 'implicit',
        username: 'ada',
        password: '  exact password  ',
        fromEmail: 'alerts@example.test',
        fromName: 'Workspace alerts',
      },
    });
  });
});
