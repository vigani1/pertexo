import { useEffect, useState } from 'react';
import {
  useLoaderData,
  useNavigate,
  useRouteContext,
} from '@tanstack/react-router';
import { PasswordResetPage } from '@/features/auth/recovery/password-reset.public';

export function PasswordResetRoute() {
  const { apiClient } = useRouteContext({ from: '/_stage/reset-password' });
  const search = useLoaderData({ from: '/_stage/reset-password' });
  const [token, setToken] = useState(search.token);
  if (search.token !== undefined && search.token !== token)
    setToken(search.token);
  const navigate = useNavigate();
  useEffect(() => {
    if (search.token !== undefined)
      void navigate({
        to: '/reset-password',
        search: { token: undefined },
        replace: true,
      });
  }, [search.token, navigate]);
  return (
    <PasswordResetPage
      key={token ?? 'missing-token'}
      apiClient={apiClient}
      {...(token === undefined ? {} : { token })}
    />
  );
}
