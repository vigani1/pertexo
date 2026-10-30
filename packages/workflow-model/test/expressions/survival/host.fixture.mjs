// A stand-in for the API or worker process: it evaluates what it is given on
// the real compiled evaluator and reports each result as one line. If an
// expression takes the process down, the parent sees the exit and the last
// line tells it which expression was running.
import { JsonataEvaluator } from '../../../dist/server.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { requests, concurrently } = JSON.parse(Buffer.concat(chunks).toString());

const report = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
const evaluator = new JsonataEvaluator();

async function evaluate({ expression, runInput = null }) {
  report({ started: expression.slice(0, 200) });
  const startedAt = Date.now();
  const result = await evaluator.evaluate({
    expression,
    context: { runInput, nodeOutputs: {} },
  });
  report({
    expression: expression.slice(0, 200),
    elapsedMs: Date.now() - startedAt,
    result: {
      kind: result.kind,
      code: result.code,
      limit: result.limit,
      message: result.message,
      value: result.value,
    },
  });
}

if (concurrently) await Promise.all(requests.map(evaluate));
else for (const request of requests) await evaluate(request);
await evaluator.shutdown();
