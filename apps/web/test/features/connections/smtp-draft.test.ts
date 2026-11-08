import { describe, expect, it } from 'vitest';
import {
  credentialErrors,
  emptyCredentialDraft,
  toCreateRequest,
} from '@/features/connections/model/credential-draft';

describe('SMTP connection form', () => {
  it('starts with required STARTTLS and identifies every missing required field', () => {
    const draft = emptyCredentialDraft('smtp', () => 'row');
    expect(draft).toMatchObject({
      provider: 'smtp',
      security: 'starttls',
      port: '587',
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
      provider: 'smtp' as const,
      host: 'smtp.example.test',
      port: '465',
      security: 'implicit' as const,
      username: 'ada',
      password: '  exact password  ',
      fromEmail: 'alerts@example.test',
      fromName: 'Workspace alerts',
    };
    expect(credentialErrors(draft)).toEqual({});
    expect(toCreateRequest('Workspace mail', draft)).toEqual({
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
