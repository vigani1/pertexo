import { foreignKey, index, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { appSchema } from '../../../namespace.js';
import { authDirectoryUsers } from './users.js';
import { authDirectoryGroups } from './groups.js';
export const authDirectoryGroupMembers = appSchema.table(
  'auth_directory_group_members',
  {
    organizationId: uuid('organization_id').notNull(),
    groupId: uuid('group_id').notNull(),
    directoryUserId: uuid('directory_user_id').notNull(),
  },
  (t) => [
    primaryKey({
      name: 'auth_directory_group_members_pkey',
      columns: [t.organizationId, t.groupId, t.directoryUserId],
    }),
    index('auth_directory_group_member_user_idx').on(
      t.organizationId,
      t.directoryUserId,
      t.groupId,
    ),
    foreignKey({
      name: 'auth_directory_group_member_group_fk',
      columns: [t.organizationId, t.groupId],
      foreignColumns: [
        authDirectoryGroups.organizationId,
        authDirectoryGroups.id,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'auth_directory_group_member_user_fk',
      columns: [t.organizationId, t.directoryUserId],
      foreignColumns: [
        authDirectoryUsers.organizationId,
        authDirectoryUsers.id,
      ],
    }).onDelete('cascade'),
  ],
);
