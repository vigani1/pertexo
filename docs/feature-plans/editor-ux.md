# Workflow editor UX

Keep the existing editor visual language and frontend contracts while making
step testing, disconnected steps and editor panels understandable at every
supported viewport.

- Use catalog display names in workflow-test history and show the latest workflow
  test's selected-step output in its Test tab, linked to full test history.
- Describe published-run emptiness accurately and distinguish it from tests.
- Show trigger-unreachable steps as advisory issues and publish warnings, and mute
  their canvas cards. Preserve palette auto-linking and unlinked drag placement.
- Reuse one presence identity and increasing heartbeat sequence per browser
  document across route remounts; separate documents remain separate tabs.
- Dock workflow-test history below the canvas, expand output below each row,
  wrap palette descriptions, and keep issue guidance readable.
- Keep test and publish dialogs stationary as data loads, with actions visible
  while long details scroll.
- Reserve space for failure-port labels and reveal the selected step when panel
  geometry changes.

Verify model/component behavior and mocked browser journeys, including light and
dark at 390×844, 360×740, 768×1024, 1024×768, 1440×900 and 1920×1080. No endpoint,
database, runtime execution or publication-admission changes.
