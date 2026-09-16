import { WorkflowPortHandle } from './workflow-port-handle';

export function WorkflowNodeHandles({
  inputPorts,
  outputPorts,
}: Readonly<{
  inputPorts: readonly string[];
  outputPorts: readonly string[];
}>) {
  return (
    <>
      {inputPorts.map((port, index) => (
        <WorkflowPortHandle
          key={`input:${port}`}
          id={port}
          label={port}
          type="target"
          top={`${String(((index + 1) / (inputPorts.length + 1)) * 100)}%`}
        />
      ))}
      {outputPorts.map((port, index) => (
        <WorkflowPortHandle
          key={`output:${port}`}
          id={port}
          label={port}
          type="source"
          top={`${String(((index + 1) / (outputPorts.length + 1)) * 100)}%`}
        />
      ))}
    </>
  );
}
