import { canonicalEmail } from '@pertexo/workflow-model';
import SCIMMY from 'scimmy';
import { z } from 'zod';
import {
  DirectoryError,
  DIRECTORY_LIMITS,
  type DirectoryUser,
  type DirectoryGroup,
  type DirectoryUserValues,
  type DirectoryGroupValues,
} from '@pertexo/core/identity';
import { canonicalDocument, requireSupportedInput } from './core.js';

const email = z.object({
  value: z.email().max(320),
  type: z.string().max(64).optional(),
  primary: z.boolean().default(false),
});
const name = z.object({
  formatted: z.string().max(512).optional(),
  familyName: z.string().max(256).optional(),
  givenName: z.string().max(256).optional(),
  middleName: z.string().max(256).optional(),
  honorificPrefix: z.string().max(128).optional(),
  honorificSuffix: z.string().max(128).optional(),
});
const userSchema = z.object({
  userName: z.string().trim().min(1).max(320),
  externalId: z.string().min(1).max(512).optional(),
  active: z.boolean().default(true),
  displayName: z.string().max(512).optional(),
  name: name.optional(),
  emails: z.array(email).min(1).max(DIRECTORY_LIMITS.emailsPerUser),
});
const groupSchema = z.object({
  displayName: z.string().trim().min(1).max(256),
  externalId: z.string().min(1).max(512).optional(),
  members: z
    .array(z.object({ value: z.uuid(), type: z.literal('User').optional() }))
    .max(DIRECTORY_LIMITS.membersPerGroup)
    .default([]),
});

export function parseDirectoryUser(input: unknown): DirectoryUserValues {
  try {
    const canonical = canonicalDocument(input);
    requireSupportedInput(canonical, 'User');
    const user = userSchema.parse(new SCIMMY.Schemas.User(canonical, 'in'));
    if (user.emails.filter((entry) => entry.primary).length > 1)
      throw new DirectoryError('invalid_value');
    const chosen = user.emails.findIndex((entry) => entry.primary);
    const primary = user.emails[chosen < 0 ? 0 : chosen];
    if (primary === undefined) throw new DirectoryError('invalid_value');
    const canonicalEntry = (
      entry: z.infer<typeof email>,
      { isPrimary }: Readonly<{ isPrimary: boolean }>,
    ) => ({
      value: canonicalEmail(entry.value),
      primary: isPrimary,
      ...(entry.type === undefined ? {} : { type: entry.type }),
    });
    const emails = [
      canonicalEntry(primary, { isPrimary: true }),
      ...user.emails
        .filter((entry) => entry !== primary)
        .map((entry) => canonicalEntry(entry, { isPrimary: false })),
    ] as const;
    if (new Set(emails.map((entry) => entry.value)).size !== emails.length)
      throw new DirectoryError('invalid_value');
    const profile = {
      ...(user.displayName === undefined
        ? {}
        : { displayName: user.displayName }),
      ...(user.name === undefined
        ? {}
        : {
            name: Object.fromEntries(
              Object.entries(user.name).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
          }),
      emails,
    };
    // Indented JSON bounds PostgreSQL's additional JSONB separator whitespace too.
    if (
      Buffer.byteLength(JSON.stringify(profile, null, 1)) >
      DIRECTORY_LIMITS.profileBytes
    )
      throw new DirectoryError('limit');
    return {
      userName: user.userName,
      externalId: user.externalId ?? null,
      active: user.active,
      profile,
    };
  } catch (error: unknown) {
    if (error instanceof DirectoryError) throw error;
    throw new DirectoryError('invalid_value');
  }
}
export function parseDirectoryGroup(input: unknown): DirectoryGroupValues {
  try {
    const canonical = canonicalDocument(input);
    requireSupportedInput(canonical, 'Group');
    const group = groupSchema.parse(new SCIMMY.Schemas.Group(canonical, 'in'));
    return {
      displayName: group.displayName,
      externalId: group.externalId ?? null,
      memberIds: [...new Set(group.members.map((member) => member.value))],
    };
  } catch (error: unknown) {
    if (error instanceof DirectoryError) throw error;
    throw new DirectoryError('invalid_value');
  }
}
const directoryEtag = (id: string, revision: number) =>
  `W/"${id}:${String(revision)}"`;
export function directoryUserDocument(user: DirectoryUser, base: string) {
  return {
    schemas: [SCIMMY.Schemas.User.id],
    id: user.id,
    userName: user.user_name,
    active: user.active,
    ...(user.external_id === null ? {} : { externalId: user.external_id }),
    ...user.profile,
    groups: user.groupIds.map((id) => ({ value: id })),
    meta: {
      resourceType: 'User',
      created: user.created_at.toISOString(),
      lastModified: user.updated_at.toISOString(),
      location: `${base}/Users/${user.id}`,
      version: directoryEtag(user.id, user.revision),
    },
  };
}
export function directoryGroupDocument(group: DirectoryGroup, base: string) {
  return {
    schemas: [SCIMMY.Schemas.Group.id],
    id: group.id,
    displayName: group.display_name,
    ...(group.external_id === null ? {} : { externalId: group.external_id }),
    members: group.memberIds.map((id) => ({ value: id })),
    meta: {
      resourceType: 'Group',
      created: group.created_at.toISOString(),
      lastModified: group.updated_at.toISOString(),
      location: `${base}/Groups/${group.id}`,
      version: directoryEtag(group.id, group.revision),
    },
  };
}
