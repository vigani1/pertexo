import { useSearch } from '@tanstack/react-router';
import { OAuth2FinishedPage } from '@/features/connections/oauth2-finished.public';

export function OAuth2FinishedRoute() {
  const search = useSearch({ strict: false });
  return <OAuth2FinishedPage search={search} />;
}
