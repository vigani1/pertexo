import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { LabelledField } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { stepTitle } from '../../model/graph/graph-adapter';
import type { InputMapping } from '../../model/inspector/input-mappings';

/** A source-format shortcut, never a claim about runtime invocation uniqueness. */
export function CallableResultStepPicker({
  nodes,
  source,
  disabled,
  onPick,
}: Readonly<{
  nodes: WorkflowGraphContract['nodes'];
  source: InputMapping;
  disabled: boolean;
  onPick: (nodeId: string) => void;
}>) {
  const selected = source.kind === 'node_output' ? source.nodeId : null;
  const missing =
    selected !== null && !nodes.some((node) => node.id === selected);
  const options = nodes.map((node) => ({
    value: node.id,
    label: stepTitle(node),
    disabled: node.disabled === true,
  }));
  if (missing)
    options.push({
      value: selected,
      label: `Outside root graph: ${selected}`,
      disabled: true,
    });
  return (
    <LabelledField
      id="callable-result-step"
      label="Result step shortcut"
      description="Picking a top-level step selects its entire output ($). Fine-tune its path in the source below. Body steps are not offered; runtime still requires exactly one successful invocation."
    >
      {(control) => (
        <Select
          items={options}
          value={selected}
          disabled={disabled || nodes.length === 0}
          onValueChange={(value) => {
            if (
              typeof value !== 'string' ||
              !nodes.some((node) => node.id === value && node.disabled !== true)
            )
              return;
            onPick(value);
          }}
        >
          <SelectTrigger {...control}>
            <SelectValue placeholder="Choose a top-level step" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {options.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      )}
    </LabelledField>
  );
}
