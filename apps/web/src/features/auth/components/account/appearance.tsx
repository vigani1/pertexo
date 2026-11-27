import { AppearanceChoice } from '@/components/patterns/appearance/choice';
import { SettingRow } from '@/components/patterns/settings/row';

export function AccountAppearanceSection() {
  return (
    <SettingRow
      layout="section"
      title="Appearance"
      description="Saved for this browser, across workspaces."
    >
      <AppearanceChoice />
    </SettingRow>
  );
}
