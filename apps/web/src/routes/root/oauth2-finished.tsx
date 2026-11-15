import { useSearch } from '@tanstack/react-router';
import { OAuth2FinishedPage } from '@/features/connections/pages/oauth2-finished';

export function OAuth2FinishedRoute() {
  const search = useSearch({ strict: false });
  return <OAuth2FinishedPage search={search} />;
}
