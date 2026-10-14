import { Button } from '@/components/ui/button';
import { expressionExamples } from '../../../model/inspector/transforms/examples';

export function ExpressionExamples({
  disabled,
  onChoose,
}: Readonly<{
  disabled: boolean;
  onChoose: (expression: string) => void;
}>) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer rounded-sm py-2 text-muted-foreground outline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        Expression examples
      </summary>
      <p className="mb-3 text-muted-foreground">
        Choosing an example replaces this expression. Review the{' '}
        <code translate="no">runInput</code> path for your data, then use Test
        to check your actual input.
      </p>
      <ul className="flex flex-col gap-3">
        {expressionExamples.map((example) => (
          <li key={example.id} className="flex min-w-0 flex-col gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-10 justify-start whitespace-normal"
              disabled={disabled}
              onClick={() => {
                onChoose(example.expression);
              }}
            >
              Use {example.name.toLowerCase()}
            </Button>
            <code
              translate="no"
              className="break-words font-mono text-[0.7rem]"
            >
              {example.expression}
            </code>
            <p className="break-words text-muted-foreground">
              Example input:{' '}
              <code translate="no" className="font-mono">
                {JSON.stringify(example.input)}
              </code>
              <br />
              Example result:{' '}
              <code translate="no" className="font-mono">
                {JSON.stringify(example.result)}
              </code>
            </p>
          </li>
        ))}
      </ul>
    </details>
  );
}
