import { Outlet } from '@tanstack/react-router';
import { AuthStage } from '@/features/auth/auth-stage.public';

/**
 * The stage the sign-in family shares. Moving between sign in, sign up and
 * password recovery swaps only the lens, so the Core and its threads keep
 * turning instead of blanking and starting again.
 */
export function AuthStageRoute() {
  return (
    <AuthStage>
      <Outlet />
    </AuthStage>
  );
}
