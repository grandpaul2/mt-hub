// Chat formatting (Discord's Markdown): marks, blocks, code that stays literal, spoilers,
// copy on code blocks; one-line snippets (reply quotes, search) show the text without marks;
// pins show it formatted.
import { api, check, done, ev, HUB, send, settle } from './lib.mjs';

const post = async (text, extra = {}, who = 'Alex') =>
  (await (await api('POST', '/api/channels/general/messages', { text, ...extra }, who)).json()).id;
const marks = await post('**bold** *it* _it2_ __u__ ~~s~~ `co*de*` ||secret|| ***both***');
const plain = await post('snake_case_name and <https://example.com/a_b_c> and \\*not italic\\*');
const code = await post('look:\n```js\nconst a = **1**; // https://example.com/x\n```\nafter');
const blocks = await post('# Title\n> quoted **b**\n- one\n- two\n1. first\n-# small print');
const rest = await post('>>> all\nof this');
const masked = await post('[the docs](https://example.com/docs) and @Pat 🔥');
await post('replying', { reply_to: marks }, 'Pat');
await api('PUT', `/api/channels/general/messages/${blocks}/pin`, undefined, 'Pat');

await send('Page.navigate', { url: HUB + '/#chan=general' });
await settle(2500);
await (await import('./lib.mjs')).shot('formatting');
const msg = (id, js) => ev(`(() => { const m = document.querySelector('#main-chat .msg[data-id="${id}"] .msg-body'); return ${js}; })()`);

check('marks', await msg(marks, `[...m.querySelectorAll('strong, em, u, s, code, .md-spoiler')].map((e) => e.tagName.toLowerCase() + ':' + e.textContent)`),
  ['strong:bold', 'em:it', 'em:it2', 'u:u', 's:s', 'code:co*de*', 'span:secret', 'strong:both', 'em:both']);
check('spoiler hidden, click shows it', [await msg(marks, `getComputedStyle(m.querySelector('.md-spoiler')).color`),
  await msg(marks, `(m.querySelector('.md-spoiler').click(), getComputedStyle(m.querySelector('.md-spoiler')).color)`)], ['rgba(0, 0, 0, 0)', 'rgb(224, 224, 224)']);
check('as typed: snake_case, a URL with underscores, escapes', [await msg(plain, `m.querySelectorAll('em').length`), await msg(plain, `m.querySelector('a')?.href`), await msg(plain, 'm.textContent')],
  [0, 'https://example.com/a_b_c', 'snake_case_name and https://example.com/a_b_c and *not italic*']);
check('code block: literal, language, no link, no preview', [await msg(code, `m.querySelector('pre.md-pre code').textContent`), await msg(code, `m.querySelector('pre').dataset.lang`),
  await msg(code, `m.querySelectorAll('pre strong, pre a').length`), await ev(`document.querySelectorAll('#main-chat .msg[data-id="${code}"] .embed').length`), await msg(code, `m.textContent.replace(m.querySelector('pre').textContent, '|')`)],
  ['const a = **1**; // https://example.com/x', 'js', 0, 0, 'look:|after']);
check('blocks', await msg(blocks, `[...m.children].map((e) => e.tagName.toLowerCase() + (e.className ? '.' + e.className.split(' ')[0] : '') + ':' + e.textContent)`),
  ['h1.md-h:Title', 'blockquote.md-quote:quoted b', 'ul.md-list:onetwo', 'ol.md-list:first', 'div.md-sub:small print']);
check('bold inside a quote', await msg(blocks, `m.querySelector('blockquote strong')?.textContent`), 'b');
check('>>> quotes the rest', await msg(rest, `m.querySelector('blockquote')?.textContent`), 'all\nof this');
check('masked link, mention, emoji', [await msg(masked, `[m.querySelector('a').textContent, m.querySelector('a').title]`), await msg(masked, `m.querySelector('.mention')?.textContent`), await msg(masked, `m.querySelector('img.emoji')?.alt`)],
  [['the docs', 'https://example.com/docs'], '@Pat', '🔥']);

await ev(`document.querySelector('#main-chat .msg[data-id="${code}"] .md-copy').click()`);
await settle(300);
check('copy code', await ev(`document.getElementById('toast').textContent`), 'Copied');

check('reply quote: no marks, spoiler hidden', await ev(`[...document.querySelectorAll('#main-chat .reply-quote .text')].map((t) => t.textContent)[0]`), 'bold it it2 u s co*de* (spoiler) both');

await ev(`(() => { const b = document.getElementById('search'); b.focus(); b.value = 'bold'; b.dispatchEvent(new Event('input')); })()`);
await settle(800);
check('search result: no marks', await ev(`document.querySelector('#search-drop .search-text')?.textContent`), 'bold it it2 u s co*de* (spoiler) both');
await ev(`document.getElementById('search').blur(); document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);

await ev(`document.querySelector('#main-chat [title="Pinned Messages"], #main-chat .pins-btn, #main-chat button[title^="Pinned"]').click()`);
await settle(800);
check('pins: formatted', await ev(`document.querySelector('.pins-pop .pin-item h1')?.textContent`), 'Title');

// Formatting keys in the message box (Discord): Ctrl+B, Ctrl+I, Ctrl+U put marks around the
// selection or take them off; nothing selected gives an empty pair with the cursor inside.
await ev(`document.querySelector('.pins-pop') && document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
const box = `document.querySelector('#main-chat .compose')`;
const ctrl = async (k) => {
  const e = { key: k, code: 'Key' + k.toUpperCase(), windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0), modifiers: 2 };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...e });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...e });
  return ev(`[${box}.value, ${box}.value.slice(${box}.selectionStart, ${box}.selectionEnd)]`);
};
await ev(`(() => { const b = ${box}; b.focus(); b.value = 'make this bold'; b.setSelectionRange(5, 9); })()`);
check('Ctrl+B wraps the selection and keeps it selected', await ctrl('b'), ['make **this** bold', 'this']);
check('the draft follows', JSON.parse(await ev(`localStorage.getItem('mt-drafts')`)).general, 'make **this** bold');
check('Ctrl+B again takes it off', await ctrl('b'), ['make this bold', 'this']);
check('Ctrl+I', await ctrl('i'), ['make *this* bold', 'this']);
check('bold on top of italic', await ctrl('b'), ['make ***this*** bold', 'this']);
check('Ctrl+I takes only the italic off', await ctrl('i'), ['make **this** bold', 'this']);
check('Ctrl+U', await ctrl('u'), ['make **__this__** bold', 'this']);
await ev(`document.execCommand('undo')`);
check('undo takes the last one back', await ev(`${box}.value`), 'make **this** bold');
await ev(`(() => { const b = ${box}; b.value = ''; b.setSelectionRange(0, 0); })()`);
check('nothing selected: an empty pair, cursor inside', [await ctrl('b'), await ev(`${box}.selectionStart`)], [['****', ''], 2]);
await ev(`(() => { const b = ${box}; b.value = ''; b.dispatchEvent(new Event('input')); })()`);

await done();
