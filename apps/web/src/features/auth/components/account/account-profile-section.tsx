import type {
  AccountSecurityResponse,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { Badge } from '@/components/ui/badge';
import { formatInitials } from '@/lib/format-initials';
import { AccountSection } from './account-section';

/** Who you are across workspaces: initials, name and email. */
export function AccountProfileSection({
  user,
  security,
}: Readonly<{
  user: UserProfileResponse;
  security: AccountSecurityResponse | undefined;
}>) {
  const email = security?.email ?? user.email;
  return (
    <AccountSection id="account-profile-title" title="Profile">
      <div className="flex items-center gap-4">
        <span
          aria-hidden="true"
          className="grid size-14 shrink-0 place-items-center rounded-full bg-raised font-heading text-lg font-bold ring-2 ring-primary/25 ring-offset-2 ring-offset-background"
        >
          {formatInitials(user.displayName || user.email)}
        </span>
        <div className="min-w-0">
          <p className="truncate font-heading text-xl font-semibold">
            {user.displayName}
          </p>
          <p className="mt-0.5 text-[0.8rem] text-subtle-foreground">
            Your name as teammates see it. Changing it isn’t available yet.
          </p>
        </div>
      </div>
      <dl className="grid gap-1">
        <dt className="text-[0.8rem] text-subtle-foreground">Email</dt>
        <dd className="flex flex-wrap items-center gap-2 text-sm">
          <span className="[overflow-wrap:anywhere]">{email}</span>
          {security === undefined ? null : security.emailVerified ? (
            <Badge variant="success">Verified</Badge>
          ) : (
            <Badge variant="warning">Not verified</Badge>
          )}
        </dd>
      </dl>
    </AccountSection>
  );
}
