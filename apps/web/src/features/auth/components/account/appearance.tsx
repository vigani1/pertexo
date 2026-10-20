import { AppearanceChoice } from '@/components/patterns/appearance-choice';
import { AccountSection } from './section';

export function AccountAppearanceSection() {
  return (
    <AccountSection
      title="Appearance"
      description="Saved for this browser, across workspaces."
    >
      <AppearanceChoice />
    </AccountSection>
  );
}
