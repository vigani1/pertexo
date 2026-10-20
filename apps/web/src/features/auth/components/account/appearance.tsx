import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { LabelledField } from '@/components/ui/field';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { setAppearance, useAppearance } from '@/lib/appearance/use-choice';
import { AccountSection } from './section';

export function AccountAppearanceSection() {
  const appearance = useAppearance();
  return (
    <AccountSection
      title="Appearance"
      description="Saved for this browser, across workspaces."
    >
      <LabelledField
        id="appearance"
        label="Theme"
        description={
          appearance.persistent
            ? 'System follows your device’s appearance, including changes while Pertexo is open.'
            : 'Your browser blocked saving this choice. It applies while this tab stays open.'
        }
      >
        {(control) => (
          <ToggleGroup
            {...control}
            aria-label="Theme"
            value={[appearance.preference]}
            onValueChange={(values) => {
              const value = values[0];
              if (value === 'system' || value === 'light' || value === 'dark')
                setAppearance(value);
            }}
          >
            <ToggleGroupItem value="system">
              <MonitorIcon aria-hidden="true" />
              System
            </ToggleGroupItem>
            <ToggleGroupItem value="light">
              <SunIcon aria-hidden="true" />
              Light
            </ToggleGroupItem>
            <ToggleGroupItem value="dark">
              <MoonIcon aria-hidden="true" />
              Dark
            </ToggleGroupItem>
          </ToggleGroup>
        )}
      </LabelledField>
    </AccountSection>
  );
}
