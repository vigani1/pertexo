import { ProviderForm } from './form';
import type { ProviderEditorProps } from './editor';
export type ProviderSelection =
  | 'new-oidc'
  | 'new-saml'
  | ProviderEditorProps['organization']['providers'][number];
/** Keep the editor mounted by provider identity while replacing server snapshots. */
export function ProviderSelectionDialog({
  selected,
  ...props
}: Omit<ProviderEditorProps, 'unavailable'> &
  Readonly<{ selected: ProviderSelection | undefined }>) {
  if (selected === undefined) return null;
  if (typeof selected === 'string')
    return (
      <ProviderForm
        key={selected}
        {...props}
        kind={selected === 'new-saml' ? 'saml' : 'oidc'}
      />
    );
  const current = props.organization.providers.find(
    (provider) => provider.id === selected.id,
  );
  return (
    <ProviderForm
      key={selected.id}
      {...props}
      provider={current ?? selected}
      unavailable={current === undefined}
    />
  );
}
