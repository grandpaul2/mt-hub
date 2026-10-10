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
const masked = await post('[the docs](https://example.com/docs) and @Paul 🔥');
await post('replying', { reply_to: marks }, 'Paul');
await api('PUT', `/api/channels/general/messages/${blocks}/pin`, undefined, 'Paul');

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
  [['the docs', 'https://example.com/docs'], '@Paul', '🔥']);

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

await done();
