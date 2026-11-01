import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type DirectoryGroup } from '@pertexo/core/identity';
import { DIRECTORY_LIMITS } from '@pertexo/workflow-model';
import { directoryGroupDocument } from '../../../../src/authentication/federation/provisioning/protocol/resources.js';
import { parseDirectoryFilter } from '../../../../src/authentication/federation/provisioning/protocol/filter.js';

describe('directory protocol budgets', () => {
  it('fits a maximum full group page under the response budget', () => {
    const now = new Date('2026-10-18T00:00:00Z');
    const group: DirectoryGroup = {
      id: randomUUID(),
      organization_id: randomUUID(),
      display_name: 'g'.repeat(256),
      external_id: 'x'.repeat(512),
      revision: 2147483647,
      created_at: now,
      updated_at: now,
      memberIds: Array.from({ length: DIRECTORY_LIMITS.membersPerGroup }, () =>
        randomUUID(),
      ),
    };
    const base =
      'https://example.test/v1/auth/federation/scim/' +
      group.organization_id +
      '/v2';
    const encoded = JSON.stringify({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: 200,
      startIndex: 1,
      itemsPerPage: DIRECTORY_LIMITS.page,
      Resources: Array.from({ length: DIRECTORY_LIMITS.page }, () =>
        directoryGroupDocument(group, base),
      ),
    });
    const bytes = Buffer.byteLength(encoded);
    expect(bytes).toBeLessThan(DIRECTORY_LIMITS.responseBytes);
  });
  it('parses maximum-length and depth filters without expanding their alternatives', () => {
    const terms = Array.from({ length: 40 }, () => 'userName pr').join(' or ');
    const source =
      '('.repeat(DIRECTORY_LIMITS.filterDepth - 1) +
      terms +
      ')'.repeat(DIRECTORY_LIMITS.filterDepth - 1);
    const padded = source.padEnd(DIRECTORY_LIMITS.filterCharacters, ' ');
    expect(parseDirectoryFilter(padded)).toMatchObject({ op: 'or' });
    expect(() => parseDirectoryFilter(padded + ' ')).toThrow();
  });
});
