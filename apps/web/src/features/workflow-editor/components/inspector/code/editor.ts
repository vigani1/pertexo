import { codeTheme, codeSyntaxStyles } from './theme';

export type CodeFieldProps = Readonly<{
  id: string;
  value: string;
  editable: boolean;
  invalid: boolean;
  describedBy: string;
  onChange: (value: string) => void;
}>;
export type CodeEditor = Readonly<{
  sync: (props: CodeFieldProps) => void;
  destroy: () => void;
}>;

/** Load the editor libraries only when the Code field mounts. */
export async function createCodeEditor(
  parent: HTMLElement,
  readProps: () => CodeFieldProps,
  signal: AbortSignal,
): Promise<CodeEditor | undefined> {
  const [state, viewModule, commands, language, javascript] = await Promise.all(
    [
      import('@codemirror/state'),
      import('@codemirror/view'),
      import('@codemirror/commands'),
      import('@codemirror/language'),
      import('@codemirror/lang-javascript'),
    ],
  );
  if (signal.aborted) return;
  const { EditorState, Compartment, Annotation, Transaction } = state;
  const {
    EditorView,
    lineNumbers,
    drawSelection,
    highlightSpecialChars,
    keymap,
  } = viewModule;
  const externalChange = Annotation.define<boolean>();
  const options = new Compartment();
  const controlOptions = (props: CodeFieldProps) => [
    EditorState.readOnly.of(!props.editable),
    EditorView.editable.of(props.editable),
    EditorView.contentAttributes.of({
      id: props.id,
      role: 'textbox',
      'aria-labelledby': `${props.id}-label`,
      'aria-multiline': 'true',
      'aria-readonly': String(!props.editable),
      'aria-invalid': String(props.invalid),
      'aria-describedby': props.describedBy,
      tabindex: '0',
      spellcheck: 'false',
      autocapitalize: 'off',
      autocorrect: 'off',
    }),
  ];
  let current = readProps();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: current.value,
      extensions: [
        lineNumbers(),
        drawSelection(),
        highlightSpecialChars(),
        commands.history(),
        keymap.of([...commands.defaultKeymap, ...commands.historyKeymap]),
        javascript.javascript(),
        language.bracketMatching(),
        language.indentOnInput(),
        EditorView.lineWrapping,
        EditorView.theme(codeTheme),
        language.syntaxHighlighting(
          language.HighlightStyle.define(codeSyntaxStyles),
        ),
        options.of(controlOptions(current)),
        EditorView.updateListener.of((update) => {
          if (
            update.docChanged &&
            update.transactions.some(
              (transaction) => !transaction.annotation(externalChange),
            )
          )
            readProps().onChange(update.state.doc.toString());
        }),
      ],
    }),
  });
  return {
    destroy: () => {
      view.destroy();
    },
    sync: (next) => {
      const changed = view.state.doc.toString() !== next.value;
      const optionsChanged =
        current.editable !== next.editable ||
        current.invalid !== next.invalid ||
        current.describedBy !== next.describedBy ||
        current.id !== next.id;
      if (changed || optionsChanged)
        view.dispatch({
          ...(changed
            ? {
                changes: {
                  from: 0,
                  to: view.state.doc.length,
                  insert: next.value,
                },
              }
            : {}),
          ...(optionsChanged
            ? { effects: options.reconfigure(controlOptions(next)) }
            : {}),
          annotations: [
            externalChange.of(true),
            Transaction.addToHistory.of(false),
          ],
        });
      current = next;
    },
  };
}
