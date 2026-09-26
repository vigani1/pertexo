import type { UserProfileResponse } from '@pertexo/contracts/schemas/identity-workspace';
import type { ReactNode } from 'react';
import { CopyButton } from '@/components/ui/copy-button';
import {
  formatDateTime,
  formatRelativeTime,
  localTimeZone,
  localUtcOffset,
} from '@/lib/format-time';
import { AccountSection } from './account-section';

function Fact({
  term,
  children,
}: Readonly<{ term: string; children: ReactNode }>) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/**
 * The account itself: how long it has existed, its ID for support, and the
 * time zone this browser shows every time in.
 */
export function AccountFactsSection({
  user,
}: Readonly<{ user: UserProfileResponse }>) {
  return (
    <AccountSection
      title="This account"
      description="Its age and ID for support, and how Pertexo shows you times."
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3">
        <Fact term="Member since">
          <time dateTime={user.createdAt}>
            {formatRelativeTime(user.createdAt)}
          </time>
          <span className="block font-mono text-[0.72rem] text-subtle-foreground">
            {formatDateTime(user.createdAt)}
          </span>
        </Fact>
        <Fact term="Account ID">
          <CopyButton
            value={user.id}
            display={`${user.id.slice(0, 8)}…`}
            label="Copy account ID"
          />
        </Fact>
        <Fact term="Time zone">
          <span className="[overflow-wrap:anywhere]">{localTimeZone()}</span>
          <span className="block font-mono text-[0.72rem] text-subtle-foreground">
            {localUtcOffset()} · from this browser
          </span>
        </Fact>
      </dl>
      <p className="text-xs text-muted-foreground">
        Times across Pertexo show in this zone. Each schedule keeps its own,
        shown beside its next runs.
      </p>
    </AccountSection>
  );
}
