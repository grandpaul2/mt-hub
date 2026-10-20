// Bundles the frontend into web/dist, which the Go binary embeds.
// `node build.mjs --watch` rebuilds on change (refresh the page; no Go restart needed with -dev).
import * as esbuild from 'esbuild';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const out = 'web/dist';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyFileSync('web/src/index.html', `${out}/index.html`);

// The new-message sound (ding.ts), made by web/src/sounds/make-message.py.
mkdirSync(`${out}/sounds`);
copyFileSync('web/src/sounds/message.mp3', `${out}/sounds/message.mp3`);

// File-tree icons: VS Code's Material Icon Theme (MIT). All SVGs are copied (the browser
// fetches only the ones it shows); map.json is the name -> icon lookup for files, plus our
// own Minecraft formats, which the theme doesn't know. Folders don't go by name: only our
// special folders (FOLDERS, by path) get an icon, everything else is a plain folder.
// Changing this list? Keep the hub's top README and hubcheck's README_DIRS in step.
const theme = 'node_modules/material-icon-theme';
cpSync(`${theme}/icons`, `${out}/icons`, { recursive: true });
copyFileSync(`${theme}/LICENSE`, `${out}/icons/LICENSE`);
const m = JSON.parse(readFileSync(`${theme}/dist/material-icons.json`, 'utf8'));
const FOLDERS = {
  commands: 'folder-command', large: 'folder-archive', 'map art': 'folder-theme', mods: 'folder-plugin',
  'mods/client': 'folder-client', 'mods/server': 'folder-server', schematics: 'folder-layout', screenshots: 'folder-images',
};
const ours = { litematic: 'minecraft', nbt: 'minecraft', schem: 'minecraft', schematic: 'minecraft' };
writeFileSync(`${out}/icons/map.json`, JSON.stringify({
  folders: FOLDERS,
  fileNames: m.fileNames,
  fileExtensions: { ...m.fileExtensions, ...ours },
}));

// Emoji: Twemoji SVGs (graphics CC-BY 4.0, Twitter/jdecked), drawn as images the way Discord
// does, so they look the same in every browser, including Linux ones with no emoji font.
// The browser fetches only the ones it shows.
const twemoji = 'node_modules/@twemoji/svg';
cpSync(twemoji, `${out}/emoji`, { recursive: true, filter: (f) => !f.endsWith('.json') && !f.endsWith('.md') });

// Emoji names and categories for the picker and :name: autocomplete (emoji.ts), from emojibase
// (MIT): Slack's short names first (Discord uses the same ones), then emojibase's own as extra
// search words. Only emoji Twemoji draws are kept, in Unicode's order; skin tones are left
// out. Each row is [emoji, category, names, label]. The page fetches it on first use.
{
  const base = 'node_modules/emojibase-data';
  const list = JSON.parse(readFileSync(`${base}/en/data.json`, 'utf8'));
  const slack = JSON.parse(readFileSync(`${base}/en/shortcodes/iamcal.json`, 'utf8'));
  const extra = JSON.parse(readFileSync(`${base}/en/shortcodes/emojibase.json`, 'utf8'));
  const arr = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
  const file = (e) => { // the Twemoji file name, as emojiImg in emoji.ts
    const cps = [...e].map((c) => c.codePointAt(0).toString(16));
    return (e.includes('\u200d') ? cps : cps.filter((c) => c !== 'fe0f')).join('-');
  };
  const rows = [];
  // emojibase's group 2 is skin-tone and hair components; the rest renumber to 0-8.
  for (const e of list.filter((e) => e.group !== undefined && e.group !== 2).sort((a, b) => a.order - b.order)) {
    // As typed on a keyboard: an emoji that's an emoji by default (type 1) loses the emoji-style
    // selector (FE0F) emojibase adds, so 👍 from the picker is the same reaction as a typed 👍.
    const ch = e.type === 1 && !e.emoji.includes('\u200d') ? e.emoji.replaceAll('\ufe0f', '') : e.emoji;
    if (!existsSync(`${twemoji}/${file(ch)}.svg`)) continue;
    // A name that's a word comes first: it's the one shown (:thumbsup:, not :+1:).
    const names = [...new Set([...arr(slack[e.hexcode]), ...arr(extra[e.hexcode])])]
      .sort((x, y) => Number(!/^[a-z]/.test(x)) - Number(!/^[a-z]/.test(y)));
    if (!names.length) continue;
    rows.push([ch, e.group > 2 ? e.group - 1 : e.group, names.join(' '), e.label.toLowerCase()]);
  }
  writeFileSync(`${out}/emoji/data.json`, JSON.stringify(rows));
}

// Voice: the microphone chain for voice chats (voice.ts, svcmic.ts), in voice/: svc-mic.wasm
// (RNNoise, SpeexDSP and Silero, built by native/svc-mic/build.sh and committed) and the audio
// worklet that runs it. Served by the hub itself; a page fetches them only when it starts voice.
mkdirSync(`${out}/voice`, { recursive: true });
copyFileSync('web/src/svc-mic.wasm', `${out}/voice/svc-mic.wasm`);
cpSync('native/svc-mic/licenses', `${out}/voice/licenses`, { recursive: true });

const common = {
  bundle: true,
  minify: !watch,
  sourcemap: watch,
  format: 'iife',
  outdir: out,
  logLevel: 'info',
  loader: { '.ttf': 'file', '.woff2': 'file' },
};
const builds = [
  // The editor and LiveKit are their own files, loaded on first use (monaco.ts, livekit.ts).
  { ...common, entryPoints: { app: 'web/src/main.ts', monaco: 'web/src/monaco.ts', livekit: 'web/src/livekit.ts' } },
  { ...common, entryPoints: { 'voice/svc-mic.worklet': 'web/src/svcmic.worklet.ts' } },
  {
    ...common,
    entryPoints: {
      'editor.worker': 'monaco-editor/editor/editor.worker',
      'json.worker': 'monaco-editor/language/json/json.worker',
    },
  },
];

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
