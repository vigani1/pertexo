import { alias } from 'drizzle-orm/pg-core';
import { authDirectoryUsers } from '../../../../schema/identity/federation/directory/users.js';
import { authDirectoryGroups } from '../../../../schema/identity/federation/directory/groups.js';
import { authDirectoryGroupMembers } from '../../../../schema/identity/federation/directory/members.js';
export const directoryUsers = alias(authDirectoryUsers, 'resource');
export const directoryGroups = alias(authDirectoryGroups, 'resource');
export const directoryMembers = alias(authDirectoryGroupMembers, 'item');
