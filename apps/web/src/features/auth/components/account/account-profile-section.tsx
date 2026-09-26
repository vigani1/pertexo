import type {
  AccountSecurityResponse,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { PencilIcon } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/lib/api/client';
import { formatInitials } from '@/lib/format-initials';
import { AccountSection } from './account-section';
import { DisplayNameForm } from './display-name-form';

/** Who you are across workspaces: initials, an editable name and email. */
export function AccountProfileSection({
  apiClient,
  user,
  security,
  onProfileChanged,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  security: AccountSecurityResponse | undefined;
  /** The name changed: reload everything that shows it. */
  onProfileChanged: () => void;
}>) {
  const [editing, setEditing] = useState(false);
  const email = security?.email ?? user.email;
  return (
    <AccountSection
      title="Name and email"
      description="How teammates see you, in every workspace."
    >
      {/* The name edits in its own row, beside the initials, so nothing
          below moves further than the form's own height. */}
      <div
        className={
          editing ? 'flex items-start gap-4' : 'flex items-center gap-4'
        }
      >
        <span
          aria-hidden="true"
          className="grid size-14 shrink-0 place-items-center rounded-full bg-raised font-heading text-lg font-bold ring-2 ring-primary/25 ring-offset-2 ring-offset-background"
        >
          {formatInitials(user.displayName || user.email)}
        </span>
        {editing ? (
          <DisplayNameForm
            apiClient={apiClient}
            user={user}
            onClose={() => {
              setEditing(false);
            }}
            onChanged={onProfileChanged}
          />
        ) : (
          <div className="min-w-0">
            <p className="flex min-w-0 items-center gap-1">
              <span className="truncate font-heading text-xl font-semibold">
                {user.displayName}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Edit your name"
                onClick={() => {
                  setEditing(true);
                }}
              >
                <PencilIcon aria-hidden="true" />
              </Button>
            </p>
          </div>
        )}
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
