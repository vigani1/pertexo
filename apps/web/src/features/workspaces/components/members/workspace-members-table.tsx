import type { WorkspaceMember } from '@pertexo/contracts/schemas/identity-workspace';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
});

export function WorkspaceMembersTable({
  members,
  canManage,
  actionsDisabled,
  onChangeRole,
}: Readonly<{
  members: readonly WorkspaceMember[];
  canManage: (member: WorkspaceMember) => boolean;
  actionsDisabled?: boolean;
  onChangeRole: (member: WorkspaceMember) => void;
}>) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Member</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Joined</TableHead>
          <TableHead>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => (
          <TableRow key={member.userId}>
            <TableCell className="min-w-56">
              <span
                className="block max-w-80 truncate font-medium"
                title={member.displayName}
              >
                {member.displayName}
              </span>
              <span
                className="mt-1 block max-w-80 truncate text-xs text-muted-foreground"
                title={member.email}
              >
                {member.email}
              </span>
            </TableCell>
            <TableCell>
              <Badge variant="muted" className="capitalize">
                {member.role}
              </Badge>
            </TableCell>
            <TableCell>
              <Badge
                variant={
                  member.membershipStatus === 'active' ? 'secondary' : 'muted'
                }
                className="capitalize"
              >
                {member.membershipStatus}
              </Badge>
            </TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">
              {dateFormatter.format(new Date(member.createdAt))}
            </TableCell>
            <TableCell className="text-right">
              {canManage(member) ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={actionsDisabled}
                  onClick={() => {
                    onChangeRole(member);
                  }}
                >
                  Change role
                </Button>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
