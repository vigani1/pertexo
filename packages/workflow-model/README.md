# Workflow model

The browser-safe shared domain vocabulary and the execution model.

`@pertexo/workflow-model` provides shared domain schemas, types and limits,
workflow graphs, value sources and control declarations. Identity primitives
and notification vocabulary stay here because applications, core, storage and
browser consumers share them. Identity, invitation, provider and delivery
policies belong to their existing core owners.

`@pertexo/workflow-model/server` provides Node-only authoring validation,
expression evaluation and graph fingerprints. Consumers use these two entry
points; implementation files remain private.
