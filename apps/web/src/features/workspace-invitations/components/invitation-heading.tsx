import type { InvitationAcceptanceJourney } from '@pertexo/contracts/schemas/identity-workspace';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { AuthLensTitle } from '@/features/auth/auth-stage.public';
import { WorkspaceMark } from '@/features/workspaces/workspace-mark.public';
import { roleCopy } from '../model/journey-copy';

type Role = Extract<
  InvitationAcceptanceJourney,
  { state: 'completed' }
>['role'];

/** The workspace's monogram in a thread ring, the title and the role. */
export function InvitationHeading({
  workspaceName,
  role,
  children,
}: Readonly<{
  workspaceName: string;
  role: Role;
  children: ReactNode;
}>) {
  const copy = roleCopy(role);
  return (
    <div className="flex flex-col items-center text-center">
      <span className="relative grid size-16 place-items-center rounded-full p-1 before:absolute before:inset-0 before:rounded-full before:bg-conic before:from-primary before:via-secondary before:to-primary before:opacity-70 before:[mask:radial-gradient(circle,transparent_calc(50%-2px),black_calc(50%-1.5px))]">
        <WorkspaceMark
          name={workspaceName}
          className="size-12 rounded-full text-base"
        />
      </span>
      <AuthLensTitle id="invitation-title" className="mt-5 text-balance">
        {children}
      </AuthLensTitle>
      <p className="mt-4 flex flex-wrap items-center justify-center gap-2 text-[0.82rem] text-muted-foreground">
        <Badge variant="secondary" className="font-semibold">
          {copy.name}
        </Badge>
        {copy.meaning}
      </p>
    </div>
  );
}
