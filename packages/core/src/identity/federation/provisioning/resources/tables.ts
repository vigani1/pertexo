import { alias } from 'drizzle-orm/pg-core';
import {
  authDirectoryUsers,
  authDirectoryGroups,
  authDirectoryGroupMembers,
} from '@pertexo/database/schema';
export const directoryUsers = alias(authDirectoryUsers, 'resource');
export const directoryGroups = alias(authDirectoryGroups, 'resource');
export const directoryMembers = alias(authDirectoryGroupMembers, 'item');
