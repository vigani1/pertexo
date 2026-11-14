import { testStackSetting } from '../../../../../../infrastructure/testing/test-stack.mjs';

// The test stack's URLs, read when an integration suite imports this. Unit
// tests import ./environment.js, which reads none.
export const adminUrl = testStackSetting('DATABASE_ADMIN_URL');
export const migrationBaseUrl = testStackSetting('DATABASE_MIGRATION_URL');
export const apiBaseUrl = testStackSetting('DATABASE_URL');
export const redisUrl = testStackSetting('REDIS_URL');
