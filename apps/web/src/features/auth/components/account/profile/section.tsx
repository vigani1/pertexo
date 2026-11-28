import type {
  AccountSecurityResponse,
  UserProfileResponse,
} from '@pertexo/contracts';
import { useState } from 'react';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/lib/api/client';
import { formatInitials } from '@/lib/format/initials';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { AccountEmailSection } from '../email-section';
import { DisplayNameForm } from './form';

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
  const [edit, setEdit] = useState<'name' | 'email'>();
  const email = security?.email ?? user.email;
  const name = user.displayName || email;
  return (
    <PageHeader>
      <div className="flex min-w-0 items-center gap-4">
        <span
          aria-hidden="true"
          className="grid size-14 shrink-0 place-items-center rounded-full bg-raised font-heading text-lg font-bold ring-1 ring-border-strong"
        >
          {formatInitials(name)}
        </span>
        <div className="min-w-0">
          <PageHeaderTitle className="wrap-anywhere">{name}</PageHeaderTitle>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="wrap-anywhere">{email}</span>
            <EmailVerification security={security} />
          </div>
        </div>
      </div>
      <PageHeaderActions>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setEdit('name');
          }}
        >
          Edit your name
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={security === undefined}
          onClick={() => {
            setEdit('email');
          }}
        >
          Change email
        </Button>
      </PageHeaderActions>
      <Sheet
        open={edit !== undefined}
        onOpenChange={(open) => {
          if (!open) setEdit(undefined);
        }}
      >
        {edit === undefined ? null : (
          <SheetContent variant="form">
            {edit === 'name' ? (
              <>
                <SheetTitle>Edit your name</SheetTitle>
                <DisplayNameForm
                  apiClient={apiClient}
                  user={user}
                  onClose={() => {
                    setEdit(undefined);
                  }}
                  onChanged={onProfileChanged}
                />
              </>
            ) : null}
            {edit === 'email' && security !== undefined ? (
              <AccountEmailSection apiClient={apiClient} security={security} />
            ) : null}
          </SheetContent>
        )}
      </Sheet>
    </PageHeader>
  );
}

function EmailVerification({
  security,
}: Readonly<{ security: AccountSecurityResponse | undefined }>) {
  if (security === undefined) return null;
  return security.emailVerified ? (
    <StatusMark tone="success">Verified</StatusMark>
  ) : (
    <StatusMark tone="attention">Not verified</StatusMark>
  );
}
