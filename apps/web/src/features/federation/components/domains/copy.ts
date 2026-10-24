export function domainStatus(
  domain: Readonly<{ verifiedAt: string | null; requireSso: boolean }>,
) {
  if (domain.verifiedAt === null)
    return { tone: 'waiting', label: 'DNS needed' } as const;
  return {
    tone: 'success',
    label: domain.requireSso ? 'SSO required' : 'Verified',
  } as const;
}
export function domainConfirmationCopy({
  action,
  required,
}: Readonly<{ action: 'enforce' | 'remove' | undefined; required: boolean }>) {
  if (action === 'remove')
    return {
      title: 'Remove this domain?',
      description: 'The organization will stop claiming this domain.',
      confirmLabel: 'Remove domain',
    };
  if (required)
    return {
      title: 'Make organization SSO optional?',
      description:
        'People can use their other configured sign-in methods again. Existing sessions for this domain will end.',
      confirmLabel: 'Make optional',
    };
  return {
    title: 'Require organization SSO?',
    description:
      'People on this domain must use organization SSO. Existing sessions will end, including yours if your account uses this domain. The control workspace owner must keep a verified password account for recovery.',
    confirmLabel: 'Require SSO',
  };
}
