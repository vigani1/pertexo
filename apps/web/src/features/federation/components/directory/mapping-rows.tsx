import {
  delegatedWorkspaceRoleSchema,
  type DirectoryMappings,
  type DirectorySettings,
} from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';

export function MappingRows({
  rows,
  groups,
  editable,
  locked,
  onChange,
  onMove,
}: Readonly<{
  rows: DirectoryMappings['mappings'];
  groups: DirectorySettings['groups'];
  editable: boolean;
  locked: boolean;
  onChange: (rows: DirectoryMappings['mappings']) => void;
  onMove: (index: number, direction: -1 | 1) => void;
}>) {
  return (
    <ol className="divide-y divide-border">
      {rows.map((mapping, index) => {
        const label =
          groups.find((group) => group.id === mapping.groupId)?.displayName ??
          'Removed group';
        return (
          <li
            key={mapping.groupId}
            className="flex flex-wrap items-center gap-3 py-3 text-sm"
          >
            <span className="min-w-0 flex-1 break-words">
              <span className="text-muted-foreground">{index + 1}. </span>
              {label}
            </span>
            {editable ? (
              <>
                <Select
                  value={mapping.role}
                  onValueChange={(value) => {
                    const parsed =
                      delegatedWorkspaceRoleSchema.safeParse(value);
                    if (parsed.success)
                      onChange(
                        rows.map((row) =>
                          row.groupId === mapping.groupId
                            ? { ...row, role: parsed.data }
                            : row,
                        ),
                      );
                  }}
                  disabled={locked}
                >
                  <SelectTrigger
                    aria-label={`Role for ${label}`}
                    className="w-32"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {delegatedWorkspaceRoleSchema.options.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex flex-wrap gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={locked || index === 0}
                    aria-label={`Move ${label} up`}
                    onClick={() => {
                      onMove(index, -1);
                    }}
                  >
                    ↑
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={locked || index === rows.length - 1}
                    aria-label={`Move ${label} down`}
                    onClick={() => {
                      onMove(index, 1);
                    }}
                  >
                    ↓
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={locked}
                    onClick={() => {
                      onChange(
                        rows.filter((row) => row.groupId !== mapping.groupId),
                      );
                    }}
                  >
                    Remove {label}
                  </Button>
                </div>
              </>
            ) : (
              <span>{mapping.role}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
