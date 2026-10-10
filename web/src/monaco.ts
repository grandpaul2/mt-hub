// The editor (Monaco), built as its own file (monaco.js + monaco.css) that main.ts loads the
// first time a text file opens, so a page that never opens one (any phone; chat on desktop)
// doesn't download it. It hands itself over as window.monaco.
import * as monaco from 'monaco-editor';

self.MonacoEnvironment = {
  getWorker: (_id: string, label: string) =>
    new Worker(label === 'json' ? '/json.worker.js' : '/editor.worker.js'),
};

// The editor measures its font when created; if JetBrains Mono arrives later, measure again.
document.fonts.load("14px 'JetBrains Mono Variable'").then(() => monaco.editor.remeasureFonts());
// No checking of JSON or JavaScript (json5 is shown as JavaScript) either.
monaco.json.jsonDefaults.setDiagnosticsOptions({ validate: false });
monaco.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true });

(window as unknown as { monaco: typeof monaco }).monaco = monaco;
