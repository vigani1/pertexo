import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts';

const timestamp = '2026-09-15T10:00:00.000Z';

/** Keep shared identity fields consistent while scenarios override their relevant facts. */
export function createUserFixture(
  overrides: Partial<UserProfileResponse> = {},
): UserProfileResponse {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    email: 'operator@example.test',
    displayName: 'Pertexo Operator',
    status: 'active',
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

type WorkspaceFixtureOptions = Omit<
  Partial<AccessibleWorkspace>,
  'capabilities'
> &
  Readonly<{ capabilities?: Readonly<AccessibleWorkspace['capabilities']> }>;

/** Each fixture gets its own capability list so scenario edits cannot leak. */
export function createWorkspaceFixture(
  overrides: WorkspaceFixtureOptions = {},
): AccessibleWorkspace {
  const { capabilities = ['workspace:read'], ...workspace } = overrides;
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    name: 'Control Operations',
    slug: 'control-operations',
    status: 'active',
    revision: 1,
    role: 'owner',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...workspace,
    capabilities: [...capabilities],
  };
}
