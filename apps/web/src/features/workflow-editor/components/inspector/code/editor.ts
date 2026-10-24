import type * as CodeMirrorLanguage from '@codemirror/language';
import { codeTheme, codeSyntaxStyles } from './theme';
import {
  CODE_LIMITS,
  type CodeLanguage,
  type CodeSyntaxIssue,
} from '@pertexo/node-sdk';
import type { EditorState as CodeEditorState } from '@codemirror/state';

export type CodeFieldProps = Readonly<{
  id: string;
  value: string;
  language: CodeLanguage;
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
  reportSyntax: (source: string, issue: CodeSyntaxIssue | undefined) => void,
): Promise<CodeEditor | undefined> {
  const [state, viewModule, commands, language, javascript, python] =
    await Promise.all([
      import('@codemirror/state'),
      import('@codemirror/view'),
      import('@codemirror/commands'),
      import('@codemirror/language'),
      import('@codemirror/lang-javascript'),
      import('@codemirror/lang-python'),
    ]);
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
  const syntax = new Compartment();
  const syntaxFor = (chosen: CodeLanguage) =>
    chosen === 'python' ? python.python() : javascript.javascript();
  const inspect = (document: CodeEditorState, chosen: CodeLanguage) => {
    inspectCodeSyntax(language, document, chosen, reportSyntax);
  };
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
        syntax.of(syntaxFor(current.language)),
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
          if (
            update.docChanged ||
            language.syntaxTree(update.startState) !==
              language.syntaxTree(update.state)
          )
            inspect(update.state, readProps().language);
        }),
      ],
    }),
  });
  inspect(view.state, current.language);
  return {
    destroy: () => {
      view.destroy();
    },
    sync: (next) => {
      const changed = view.state.doc.toString() !== next.value;
      const languageChanged = current.language !== next.language;
      const optionsChanged =
        current.editable !== next.editable ||
        current.invalid !== next.invalid ||
        current.describedBy !== next.describedBy ||
        current.id !== next.id;
      if (changed || optionsChanged || languageChanged)
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
          effects: [
            ...(optionsChanged
              ? [options.reconfigure(controlOptions(next))]
              : []),
            ...(languageChanged
              ? [syntax.reconfigure(syntaxFor(next.language))]
              : []),
          ],
          annotations: [
            externalChange.of(true),
            Transaction.addToHistory.of(false),
          ],
        });
      if (languageChanged) inspect(view.state, next.language);
      current = next;
    },
  };
}

function inspectCodeSyntax(
  language: typeof CodeMirrorLanguage,
  document: CodeEditorState,
  chosen: CodeLanguage,
  reportSyntax: (source: string, issue: CodeSyntaxIssue | undefined) => void,
) {
  const source = document.doc.toString();
  if (chosen === 'python' && source.length <= CODE_LIMITS.sourceBytes) {
    // Reuse CodeMirror's incremental grammar and keep typing work bounded.
    const tree = language.ensureSyntaxTree(document, document.doc.length, 50);
    const cursor = tree?.cursor();
    if (cursor === undefined) {
      reportSyntax(source, undefined);
      return;
    }
    do {
      if (!cursor.type.isError) continue;
      const position = Math.min(cursor.from, document.doc.length);
      const line = document.doc.lineAt(position);
      reportSyntax(source, {
        message:
          'Check Python syntax here. Preview gives the compiler’s precise error.',
        line: line.number,
        column: position - line.from + 1,
      });
      return;
    } while (cursor.next());
  }
  reportSyntax(source, undefined);
}
