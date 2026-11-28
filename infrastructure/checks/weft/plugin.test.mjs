import { describe, it } from 'node:test';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { deepEqual } from 'node:assert/strict';
import { rules } from './plugin.mjs';
import { styles } from './styles.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const filename = 'apps/web/src/features/example/components/example.tsx';
const valid = (code, file = filename) => ({ code, filename: file });
const invalid = (code, count = 1, file = filename) => ({
  ...valid(code, file),
  errors: Array.from({ length: count }, () => ({ messageId: 'weft' })),
});

tester.run('no-raw-colors', rules['no-raw-colors'], {
  valid: [
    valid("const color = 'var(--foreground)'; <use href='icons.svg#abc' />;"),
    valid(
      "const paint = 'url(#abc)'; <use href='#abc' />; document.querySelector('#abc');",
    ),
    valid(
      'const color = `rgba(${channels},${alpha})`;',
      'apps/web/src/lib/canvas-scene.ts',
    ),
  ],
  invalid: [
    invalid("<div style={{ color: '#1234' }} />; <path fill='#aabbcc' />;", 2),
    invalid(
      "const colors = ['rgb(1 2 3)', 'hsl(10 20% 30%)', `oklch(${lightness} 0 0)`];",
      3,
    ),
  ],
});

describe('Weft stylesheet colors', () => {
  it('keeps valid CSS references and reports a raw declaration at its source', () => {
    const file = 'apps/web/src/components/example.css';
    styles.preprocess(
      '#abc { color: var(--ink); mask: url("#def"); }\n.example { color: #abcdef; }',
      file,
    );
    deepEqual(styles.postprocess([], file), [
      {
        ruleId: 'weft/no-raw-colors',
        severity: 2,
        message: 'Use a Weft theme color token.',
        line: 2,
        column: 12,
      },
    ]);
  });
});

tester.run('semantic-color-utilities', rules['semantic-color-utilities'], {
  valid: [
    valid(
      `const classes = 'bg-well text-label border-[1.5px] text-[length:12px] bg-[url(/mask.svg)] [mask-image:linear-gradient(black,transparent)]';`,
    ),
  ],
  invalid: [
    invalid(
      "const classes = 'hover:decoration-white/20 supports-[display:grid]:!bg-red-500/[.4]';",
      2,
    ),
    invalid(
      '<div className="bg-[rebeccapurple] border-[color:hsl(0_0%_0%)]/50 fill-[#fff]!" />;',
      3,
    ),
  ],
});

tester.run('quick-duration-token', rules['quick-duration-token'], {
  valid: [
    valid(
      "const classes = 'duration-(--duration-quick) delay-150 duration-1500';",
    ),
  ],
  invalid: [
    invalid("const classes = 'duration-150 group-hover/foo:duration-150!';", 2),
  ],
});

tester.run('control-radius-token', rules['control-radius-token'], {
  valid: [
    valid(
      "<div className='rounded-xs rounded-[1px] rounded-[inherit] h-[5px]' />;",
    ),
  ],
  invalid: [
    invalid(
      "<div className='rounded-[5px] hover:rounded-tr-[.3125rem]' />;",
      2,
    ),
  ],
});

tester.run(
  'shared-component-appearance',
  rules['shared-component-appearance'],
  {
    valid: [
      valid(
        "import { Input, Textarea } from '@/components/ui/input'; <Input typography='mono' className='w-full md:max-w-md border-[1.5px]' />; <Textarea className='min-h-32' />;",
      ),
      valid(
        "import { Disclosure } from '@/components/ui/disclosure'; <Disclosure className='mt-3' contentClassName='border-t pt-2' />;",
      ),
      valid(
        "import { ToggleGroup } from '@/components/ui/toggle-group'; <ToggleGroup appearance='frameless' className='flex-wrap' />;",
      ),
      valid(
        "import { Skeleton } from '@/components/ui/skeleton'; <Skeleton shape='round' className='size-4' />;",
      ),
      valid(
        "import { Button } from './button'; <Button className='rounded-full text-sm' />;",
      ),
      valid(
        "import { Button } from '@/components/ui/button'; function render(Button) { return <Button className='shadow-lg' />; }",
      ),
    ],
    invalid: [
      invalid(
        "import { Input as Field } from '@/components/ui/input'; <Field className={cn('w-full', active && 'font-mono border-action')} />;",
      ),
      invalid(
        "import { Textarea } from '@/components/ui/textarea'; const type = active ? 'text-sm' : 'w-full'; <Textarea className={type} />;",
      ),
      invalid(
        "import * as UI from '@/components/ui/disclosure'; <UI.Disclosure className='border-t' />;",
      ),
      invalid(
        "import { ToggleGroup, ToggleGroupItem } from '../../../components/ui/toggle-group'; <ToggleGroup className='border-0 bg-transparent'><ToggleGroupItem className='rounded-md data-pressed:bg-select' /></ToggleGroup>;",
        2,
      ),
      invalid(
        "import { Skeleton } from '@/components/ui/skeleton'; <Skeleton className={ready ? 'rounded-full' : 'rounded-xs'} />;",
      ),
      invalid(
        "import { Notice } from '@/components/patterns/notices/inline-notice'; <Notice className='focus:shadow-raised text-warning' />;",
      ),
    ],
  },
);

tester.run(
  'no-retired-component-imports',
  rules['no-retired-component-imports'],
  {
    valid: [
      valid(
        "import { DeadlineField } from '@/components/patterns/dates/deadline-field';",
      ),
    ],
    invalid: [
      invalid(
        "import { DeadlineField } from '@/components/ui/deadline-field';",
      ),
      invalid(
        "export { TimedOutGlyph } from '../../catalog/components/timed-out-glyph.tsx';",
      ),
      invalid("void import('@/components/patterns/settings/section');"),
      invalid(
        "import { WorkflowNameField as Name } from '@/features/workflows/workflows-views.public';",
      ),
    ],
  },
);

tester.run('feature-hook-placement', rules['feature-hook-placement'], {
  valid: [
    valid(
      'export function useExample() {}',
      'apps/web/src/features/example/hooks/inner/use-example.ts',
    ),
    valid(
      'export function useExample() {}',
      'apps/web/src/features/example/data/mutations/use-example.ts',
    ),
  ],
  invalid: [
    invalid(
      'export function useExample() {}',
      1,
      'apps/web/src/features/example/components/inner/use-example.ts',
    ),
  ],
});

tester.run('tsx-requires-jsx', rules['tsx-requires-jsx'], {
  valid: [
    valid('const view = <><input /></>;'),
    valid('type View = React.ReactNode;', 'apps/web/src/view.ts'),
  ],
  invalid: [invalid('type View = React.ReactNode;')],
});

tester.run('native-disclosure-owner', rules['native-disclosure-owner'], {
  valid: [
    valid(
      "import { Disclosure } from '@/components/ui/disclosure'; <Disclosure />;",
    ),
    valid(
      '<details><summary>More</summary></details>;',
      'apps/web/src/components/ui/disclosure.tsx',
    ),
  ],
  invalid: [invalid('<details><summary>More</summary></details>;', 2)],
});
