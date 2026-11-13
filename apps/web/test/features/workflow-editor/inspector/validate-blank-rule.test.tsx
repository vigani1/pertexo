import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { ValidateRules } from '@/features/workflow-editor/components/inspector/builders/validate-rules';
import { readValidateRules } from '@/features/workflow-editor/model/inspector/setup-builders';
import type { NodeConfig } from '@/features/workflow-editor/model/inspector/draft';
import type { NodeFormApi } from '@/features/workflow-editor/model/inspector/node-form';

/** A new Validate step, as the catalog starts it, with what it stores. */
function NewValidate() {
  const [config, setConfig] = useState<NodeConfig>({});
  const form: NodeFormApi = {
    nodeId: 'validate',
    editable: true,
    reportScratch: vi.fn(),
    commit: (update) => {
      setConfig((current) => {
        const next =
          typeof update === 'function'
            ? update({
                id: 'validate',
                definition: { key: 'core.validate', version: 1 },
                configVersion: 1,
                position: { x: 0, y: 0 },
                config: current,
                inputMappings: {},
                connectionRefs: {},
              })
            : update;
        return next.config ?? current;
      });
    },
  };
  return (
    <>
      <ValidateRules rules={readValidateRules(config) ?? []} form={form} />
      <output aria-label="Saved setup">{JSON.stringify(config)}</output>
    </>
  );
}

const saved = (): unknown =>
  JSON.parse(screen.getByRole('status', { name: 'Saved setup' }).textContent);

it('opens with one blank rule and saves it only once it has a path', async () => {
  const user = userEvent.setup();
  render(<NewValidate />);
  expect(screen.getByText('Rule 1')).toBeVisible();
  const path = screen.getByRole('textbox', { name: 'Path' });
  expect(path).toHaveValue('');
  // Choosing options on the blank row keeps them, but saves nothing yet.
  await user.click(screen.getByRole('switch', { name: 'Must be there' }));
  expect(saved()).toEqual({});
  await user.type(path, 'email');
  expect(saved()).toEqual({
    rules: [{ id: 'rule-1', path: '$.email', required: false }],
  });
});

it('keeps a second blank row unsaved until one row is filled', async () => {
  const user = userEvent.setup();
  render(<NewValidate />);
  await user.click(screen.getByRole('button', { name: 'Add rule' }));
  expect(screen.getByText('Rule 2')).toBeVisible();
  expect(saved()).toEqual({});
});
