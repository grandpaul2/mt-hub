// Text files: they open in View (read only) with a View | Edit switch; Edit is a plain editor
// (no suggestions, auto-closing brackets, right-click menu or squiggles); the text size is
// remembered; switching keeps the reader's place. Also checks the page's own fonts.
import { answerDialogs, asked, check, COOKIE, done, ev, HUB, key, send, settle, shot, sleep, ws } from './lib.mjs';

const put = (path, body) => fetch(`${HUB}/api/file/${path}?base=`, { method: 'PUT', headers: { cookie: COOKIE.Paul }, body });
await put('notes.txt', 'phantom farm start\nphantom farm stop\n');
await put('bad.json', '{"a": 1,, "b": }');
// A long Markdown file: headings, paragraphs and lists, each line numbered.
const md = Array.from({ length: 60 }, (_, i) => i % 10 === 0 ? `## Section ${i / 10}\n\nline ${i} intro paragraph that is long enough to wrap when the text is zoomed in a lot, line ${i}.\n` : `- item on line ${i}\n`).join('');
await put('long.md', md);
const open = async (p) => {
  await send('Page.navigate', { url: `${HUB}/?r=${Math.random()}#${p}` });
  await settle(2000);
};
await send('Page.navigate', { url: HUB });
await settle(500);
await answerDialogs(true); // unsaved-changes questions: answered yes unless a step says no
await open('notes.txt');

// Our own fonts, served by the hub, never the system's: the page in Noto Sans, the editor
// in JetBrains Mono, both loaded.
check('fonts', await ev(`document.fonts.ready.then(() => [
  getComputedStyle(document.querySelector('#tree .name')).fontFamily,
  getComputedStyle(document.querySelector('.monaco-editor .view-lines')).fontFamily.split(',')[0],
  document.fonts.check("14px 'Noto Sans Variable'"), document.fonts.check("14px 'JetBrains Mono Variable'")])`),
  ['"Noto Sans Variable", sans-serif', '"JetBrains Mono Variable"', true, true]);
// Opens in View (read only) with a blue Edit; editing, that button is View (same place and
// size; Cancel once something changed) with a grey Save on its left that turns blue then.
const buttons = () => ev(`[...document.querySelectorAll('#toolbar .single-actions > button')].filter((b) => getComputedStyle(b).visibility === 'visible')
  .map((b) => b.textContent + (b.classList.contains('primary') ? '*' : '') + (b.disabled ? '(off)' : ''))`);
const press = (label) => ev(`[...document.querySelectorAll('#toolbar .single-actions > button')].find((b) => b.textContent === '${label}').click()`);
const toggleBox = () => ev(`(() => { const r = document.querySelector('#toolbar .edit-toggle').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)]; })()`);
check('opens in view', await buttons(), ['Edit*', 'History']);
const viewBox = await toggleBox();
await press('Edit');
await settle(500);
check('editing: View in the same place, grey Save', [await buttons(), JSON.stringify(await toggleBox()) === JSON.stringify(viewBox)], [['Save(off)', 'View*', 'History'], true]);
const lines = await ev(`(() => { const r = document.querySelector('.monaco-editor .view-lines').getBoundingClientRect(); return [r.x, r.y, r.width]; })()`);
for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: lines[0] + 300, y: lines[1] + 50, button: 'left', clickCount: 1 });
await settle(200);
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 2 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 2 });
for (const ch of 'pha') { await send('Input.dispatchKeyEvent', { type: 'char', text: ch }); await settle(120); }
await settle(800);
check('no suggestion box while typing', await ev(`!!document.querySelector('.suggest-widget.visible')`), false);
await shot('editor-typing');
for (const ch of ' ("x') { await send('Input.dispatchKeyEvent', { type: 'char', text: ch }); await settle(80); }
await settle(300);
check('no auto-closed bracket/quote', await ev(`document.querySelector('.monaco-editor .view-lines').innerText.replace(/\\u00a0/g, ' ').trim().split('\\n').pop()`), 'pha ("x');
const r = await ev(`(() => { const b = document.querySelector('.monaco-editor .view-lines').getBoundingClientRect(); return [b.x + 40, b.y + 10]; })()`);
for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: r[0], y: r[1], button: 'right', clickCount: 1 });
await settle(300);
check('no editor right-click menu', await ev(`!!document.querySelector('.monaco-menu-container, .context-view .monaco-menu')`), false);
await key('Escape');
check('unsaved: Save turns blue, View becomes Cancel', [await buttons(), JSON.stringify(await toggleBox()) === JSON.stringify(viewBox)], [['Save*', 'Cancel*', 'History'], true]);
// History while editing comes back to the edit, changes and all.
await press('History'); await settle(500);
await press('Close history'); await settle(600);
check('history keeps the edit', [await buttons(), await ev(`document.querySelector('.monaco-editor .view-lines').innerText.replace(/\\u00a0/g, ' ').includes('pha ("x')`)], [['Save*', 'Cancel*', 'History'], true]);
// Cancel, or opening another file, with unsaved changes warns; saying no keeps the changes.
await answerDialogs(false);
await press('Cancel'); await settle(400);
await ev(`document.querySelector('.row[data-path="bad.json"]').click()`); await settle(800);
check('warned, kept', [await asked(), await ev('location.hash'), await buttons()],
  [['Discard your changes to notes.txt?', 'Discard your changes to notes.txt?'], '#notes.txt', ['Save*', 'Cancel*', 'History']]);
await answerDialogs(true);
// Cancel, saying yes: the saved text again, back in View.
await press('Cancel');
await settle(800);
check('cancel discards and goes to view', [(await asked()).length, await buttons(), await ev(`fetch('/api/file/notes.txt').then((r) => r.text())`),
  await ev(`document.querySelector('.monaco-editor .view-lines').innerText.replace(/\\u00a0/g, ' ').trim().split('\\n').pop()`)],
  [1, ['Edit*', 'History'], 'phantom farm start\nphantom farm stop\n', 'phantom farm stop']);
await send('Page.navigate', { url: 'about:blank' });
await settle(300);
await open('bad.json');
await sleep(1500); // the editor would check the file in the background, where settle() can't see
check('no error squiggles on broken JSON', await ev(`document.querySelectorAll('.squiggly-error, .squiggly-warning').length`), 0);

// Text size: the Size slider at the bar's far right (the percentage in its tooltip, a
// double-click back to 100%), in view and edit, remembered. No magnifiers: those mean search.
const S = `document.querySelector('#toolbar .size input')`;
const size = () => ev(`[${S}.value, ${S}.title, getComputedStyle(document.querySelector('.monaco-editor .view-lines')).fontSize]`);
check('text size 100%', await size(), ['100', 'Text size: 100% (double-click for 100%)', '14px']);
check('Size is the last thing on the bar', await ev(`(() => { const a = document.querySelector('#toolbar .single-actions'); return [a.lastElementChild.textContent.trim(), a.lastElementChild === ${S}.parentElement]; })()`), ['Size', true]);
await ev(`(() => { const s = ${S}; s.value = '120'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await settle(300);
check('bigger', await size(), ['120', 'Text size: 120% (double-click for 100%)', '16.8px']);
await open('long.md');
check('remembered, markdown too', [await ev(`${S}.value`), await ev(`getComputedStyle(document.querySelector('.markdown')).fontSize`)], ['120', '15.6px']);
await ev(`${S}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
await settle(200);
check('a double-click resets', [await ev(`${S}.value`), await ev(`getComputedStyle(document.querySelector('.markdown')).fontSize`)], ['100', '13px']);

// Switching keeps the place: scroll the view to "Section 3", switch to Edit: that line is at
// the top; scroll the editor to line 45, switch back: the view shows line 45 at the top.
const topText = () => ev(`(() => { const v = document.getElementById('view').getBoundingClientRect(); const e = document.elementFromPoint(v.left + 60, v.top + 4); return e?.closest('h2, p, li')?.textContent ?? e?.textContent; })()`);
await ev(`(() => { const h = [...document.querySelectorAll('.markdown h2')].find((x) => x.textContent === 'Section 3'); document.getElementById('view').scrollTop = h.closest('[data-line]').offsetTop; })()`);
await settle(200);
check('view at section 3', await topText(), 'Section 3');
await press('Edit');
await settle(600);
// editorTop: the text of the editor's first line on screen.
const editorTop = () => ev(`(() => { const box = document.querySelector('.monaco-editor .view-lines').parentElement.getBoundingClientRect();
  const l = [...document.querySelectorAll('.monaco-editor .view-line')].filter((e) => e.getBoundingClientRect().bottom > box.top + 2).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
  return l?.textContent.replace(/\u00a0/g, ' '); })()`);
check('edit opens at the same line', await editorTop(), '## Section 3');
// Scroll the editor down with the wheel, then View and back to Edit: the view shows that
// line at the top, and the editor comes back to it.
const at = await ev(`(() => { const r = document.querySelector('.monaco-editor').getBoundingClientRect(); return [r.x + 200, r.y + 100]; })()`);
await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at[0], y: at[1], deltaX: 0, deltaY: 300 });
await settle(500);
const before = await editorTop();
await press('View');
await settle(600);
const inView = await topText();
await press('Edit');
await settle(600);
const after = await editorTop();
const num = (t) => Number(/line (\d+)/.exec(t ?? '')?.[1] ?? /Section (\d+)/.exec(t ?? '')?.[1] * 10);
check('back and forth: the same place', [Math.abs(num(inView) - num(before)) <= 1, Math.abs(num(after) - num(before)) <= 1, before !== '## Section 3'], [true, true, true]);
console.log('  (editor top', JSON.stringify(before), '→ view top', JSON.stringify(inView), '→ editor top', JSON.stringify(after) + ')');
await shot('switch');

await done();
