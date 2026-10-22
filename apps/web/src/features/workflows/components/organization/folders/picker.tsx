import { useId } from 'react';
import type { WorkflowFolder } from '@pertexo/contracts';
import { LabelledField } from '@/components/ui/field';
import { workflowFolderOptions } from '../../../model/organization/folder-navigation';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const ROOT = 'organization-unfiled';

/** Current bounded hierarchy is navigation, never a permission grant. */
export function WorkflowFolderPicker({
  folders,
  value,
  onChange,
  disabled = false,
  label = 'Folder',
  rootLabel = 'Unfiled / top level',
}: Readonly<{
  folders: readonly WorkflowFolder[];
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  label?: string;
  rootLabel?: string;
}>) {
  const id = useId();
  const items = [
    { value: ROOT, label: rootLabel },
    ...workflowFolderOptions(folders),
  ];
  return (
    <LabelledField id={id} label={label}>
      {(control) => (
        <Select
          items={items}
          value={value ?? ROOT}
          disabled={disabled}
          onValueChange={(next) => {
            if (next !== null) onChange(next === ROOT ? null : next);
          }}
        >
          <SelectTrigger {...control}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {items.map((item) => (
                <SelectItem
                  key={item.value}
                  value={item.value}
                  disabled={
                    folders.find((folder) => folder.id === item.value)
                      ?.canCreateWorkflows === false
                  }
                >
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      )}
    </LabelledField>
  );
}
