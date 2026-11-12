import { isSessionIdentityChangedError } from '@/features/auth/session/identity.public';
import { isApiError } from '@/lib/api/error';
export function isDuplicateAccessLoss(error: unknown) {
  return (
    isSessionIdentityChangedError(error) ||
    (isApiError(error) && [401, 403, 404].includes(error.status ?? 0))
  );
}
