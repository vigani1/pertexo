import { useRouterState } from '@tanstack/react-router';
import { LensLoading } from '@/features/auth/auth-stage.public';

const PENDING: Readonly<
  Record<string, readonly [title: string, label: string]>
> = {
  '/login': ['Sign in to continue', 'Checking your session…'],
  '/sign-up': ['Create your account', 'Opening sign up…'],
  '/forgot-password': ['Reset your password', 'Opening password reset…'],
  '/reset-password': ['Choose a new password', 'Opening password reset…'],
  '/account/migrate': ['Move your sign-in', 'Opening account recovery…'],
};

/** A lens on the stage while its page loads, titled as the page will be. */
export function AuthLensPending() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const [title, label] = PENDING[pathname] ?? ['Pertexo', 'Opening Pertexo…'];
  return <LensLoading title={title} label={label} />;
}
