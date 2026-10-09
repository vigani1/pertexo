import { useRouteContext } from '@tanstack/react-router';
import { LegacyMigrationPage } from '@/features/auth/legacy-migration.public';

export function LegacyMigrationRoute() {
  const { apiClient } = useRouteContext({ from: '/_stage/account/migrate' });
  return <LegacyMigrationPage apiClient={apiClient} />;
}
