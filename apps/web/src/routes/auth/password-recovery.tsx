import { useRouteContext } from '@tanstack/react-router';
import { PasswordRecoveryPage } from '@/features/auth/recovery/password.public';

export function PasswordRecoveryRoute() {
  const { apiClient } = useRouteContext({ from: '/_stage/forgot-password' });
  return <PasswordRecoveryPage apiClient={apiClient} />;
}
