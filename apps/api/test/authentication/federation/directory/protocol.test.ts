import { describe, expect, it } from 'vitest';
import {
  parseDirectoryUser,
  parseDirectoryGroup,
} from '../../../../src/authentication/federation/provisioning/protocol/resources.js';
import {
  applyDirectoryPatch,
  parseDirectoryPatch,
} from '../../../../src/authentication/federation/provisioning/protocol/patch.js';
import { parseDirectoryFilter } from '../../../../src/authentication/federation/provisioning/protocol/filter.js';

const user = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
  id: '11111111-1111-4111-8111-111111111111',
  userName: 'Member@example.test',
  active: true,
  emails: [{ value: 'Member@example.test', primary: true, type: 'work' }],
  groups: [],
  meta: {
    resourceType: 'User',
    created: '2026-10-18T00:00:00.000Z',
    lastModified: '2026-10-18T00:00:00.000Z',
    version: 'opaque',
  },
};
const patch = (Operations: unknown[]) => ({
  schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
  Operations,
});
describe('the pinned SCIM schema/filter/patch boundary', () => {
  it('switches primary email before the next operation without mutating the saved resource', () => {
    const source = {
      ...user,
      emails: [
        ...user.emails,
        { value: 'other@example.test', primary: false, type: 'home' },
      ],
    };
    const changed = parseDirectoryUser(
      applyDirectoryPatch(
        source,
        parseDirectoryPatch(
          patch([
            {
              op: 'replace',
              path: 'emails[value eq "other@example.test"].primary',
              value: true,
            },
            {
              op: 'replace',
              path: 'emails[primary eq true].type',
              value: 'other',
            },
          ]),
          'User',
        ),
      ),
    );
    expect(changed.profile.emails).toEqual([
      { value: 'other@example.test', primary: true, type: 'other' },
      { value: 'member@example.test', primary: false, type: 'work' },
    ]);
    expect(source.emails[0]?.primary).toBe(true);
    expect(source.emails[1]?.primary).toBe(false);
  });
  it('refuses nested groups rather than treating their references as users', () => {
    expect(() =>
      parseDirectoryGroup({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'Nested',
        members: [{ value: user.id, type: 'Group' }],
      }),
    ).toThrow();
  });
  it('canonicalizes attribute casing and primary email without binding an account', () => {
    expect(
      parseDirectoryUser({
        SCHEMAS: user.schemas,
        USERNAME: 'Person',
        EMAILS: [
          { VALUE: 'SECOND@example.test', PRIMARY: false },
          { VALUE: 'Primary@example.test', PRIMARY: true },
        ],
        ACTIVE: true,
        NAME: { GIVENNAME: 'Person' },
      }),
    ).toEqual({
      userName: 'Person',
      externalId: null,
      active: true,
      profile: {
        emails: [
          { value: 'primary@example.test', primary: true },
          { value: 'second@example.test', primary: false },
        ],
        name: { givenName: 'Person' },
      },
    });
  });
  it.each([
    { ...user, userName: undefined },
    { ...user, password: 'never-store' },
    { ...user, schemas: [] },
    { ...user, userName: 'first', USERNAME: 'second' },
    { ...user, emails: [{ value: 'invalid' }] },
    {
      ...user,
      emails: [
        { value: 'one@example.test', primary: true },
        { value: 'two@example.test', primary: true },
      ],
    },
    {
      ...user,
      emails: Array.from({ length: 6 }, (_, index) => ({
        value: `a${String(index)}@example.test`,
      })),
    },
    { ...user, ['urn:example:extension']: { secret: 'no' } },
  ])(
    'refuses ambiguous, unsupported, malformed or over-budget user input',
    (input) => {
      expect(() => parseDirectoryUser(input)).toThrow(
        'Directory operation is not permitted',
      );
    },
  );
  it('uses the actual PATCH SDK for Entra-style whole-object and case-insensitive filtered edits', () => {
    const result = applyDirectoryPatch(
      user,
      parseDirectoryPatch(
        patch([
          { op: 'REPLACE', value: { ACTIVE: false } },
          {
            op: 'replace',
            path: 'EMAILS[VALUE eq "MEMBER@example.test"].TYPE',
            value: 'home',
          },
        ]),
        'User',
      ),
    );
    expect(parseDirectoryUser(result)).toMatchObject({
      active: false,
      profile: { emails: [{ value: 'member@example.test', type: 'home' }] },
    });
    expect(user.active).toBe(true);
    expect(user.emails[0]?.type).toBe('work');
  });
  it('keeps the original unchanged when a later operation fails', () => {
    expect(() =>
      applyDirectoryPatch(
        user,
        parseDirectoryPatch(
          patch([
            { op: 'replace', path: 'active', value: false },
            {
              op: 'replace',
              path: 'emails[value eq "absent"].value',
              value: 'other@example.test',
            },
          ]),
          'User',
        ),
      ),
    ).toThrow();
    expect(user.active).toBe(true);
    expect(user.emails[0]?.value).toBe('Member@example.test');
  });
  it.each(['id', 'meta.version', 'schemas', 'groups'])(
    'rejects read-only edits before coercion can discard %s',
    (path) => {
      expect(() =>
        applyDirectoryPatch(
          user,
          parseDirectoryPatch(
            patch([
              {
                op: 'replace',
                path,
                value: readOnlyPatchValue(path),
              },
            ]),
            'User',
          ),
        ),
      ).toThrow(expect.objectContaining({ reason: 'mutability' }));
    },
  );
  it('accepts a standard group and deduplicates its stable user references', () => {
    expect(
      parseDirectoryGroup({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'Builders',
        members: [{ value: user.id }, { value: user.id }],
      }),
    ).toEqual({
      displayName: 'Builders',
      externalId: null,
      memberIds: [user.id],
    });
  });
  it('preserves negated value paths and rejects trailing garbage and unsafe depth before parsing', () => {
    expect(parseDirectoryFilter('not (emails[value eq "x"])')).toMatchObject({
      op: 'not',
      filter: { op: '[]' },
    });
    for (const source of [
      'userName eq "member" trailing',
      `${'('.repeat(17)}active eq true${')'.repeat(17)}`,
      'x'.repeat(1025),
    ])
      expect(() => parseDirectoryFilter(source)).toThrow();
  });
});

function readOnlyPatchValue(path: string) {
  if (path === 'groups') return [{ value: user.id }];
  if (path === 'schemas') return [];
  return 'changed';
}
