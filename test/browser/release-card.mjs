// Mod release cards: a post shaped like a release is drawn as a card (label, mod and
// version, tags, changes, a Note when there is one, Readme for the mod's page, the jar's Download); a file that left Files shows a muted
// line; anything not quite that shape stays ordinary formatted text; snippets stay plain.
import { api, check, done, ev, HUB, hub, send, settle, shot } from './lib.mjs';

await hub('/api/file/mods/client/mthub-1.3.1.jar?base=', { method: 'PUT', body: 'x'.repeat(2048) });
// Our mods' pages: the cards' Readme buttons find them by the mod's name.
await hub(`/api/file/mods/${encodeURIComponent('mod info')}/${encodeURIComponent('MT Hub.md')}?base=`, { method: 'PUT', body: '# MT Hub\n' });
await hub(`/api/file/mods/${encodeURIComponent('mod info')}/${encodeURIComponent('Server tweak.md')}?base=`, { method: 'PUT', body: '# Server tweak\n' });

const post = async (text, who = 'Pat') =>
  (await (await api('POST', '/api/channels/general/messages', { text }, who)).json()).id;
const full = await post('## MT Hub 1.3.1\n-# Client · Optional\n#mods/client/mthub-1.3.1.jar\n- [Upload to hub] on its own line\n- Join **Link** in Simple Voice Chat\n**Note:** on Linux, install `vlc`.');
const gone = await post('## WaterFrames 2.1.22-mt4\n-# Client + Server · Required\n#mods/client/waterframes-mt4.jar\n- Shader mode');
const bare = await post('## Server tweak\n-# Server\n- Faster restarts');
const plain = await post('## Not a release\n-# just small text\n- a list');

await send('Page.navigate', { url: HUB + '/#chan=general' });
await settle(2500);
await shot('release-card');
const card = (id, js) => ev(`(() => { const c = document.querySelector('#main-chat .msg[data-id="${id}"] .rel-card'); return c && (${js}); })()`);

check('drawn as a card', [await card(full, '!!c'), await card(plain, '!!c')], [true, null]);
check('label, name, version', await card(full, `[c.querySelector('.rel-label').textContent, c.querySelector('.rel-name').textContent, c.querySelector('.rel-version').textContent]`),
  ['Mod release', 'MT Hub', '1.3.1']);
check('tags; Required stands out', [await card(full, `[...c.querySelectorAll('.rel-tag')].map((t) => t.textContent + (t.classList.contains('required') ? '!' : ''))`),
  await card(gone, `[...c.querySelectorAll('.rel-tag')].map((t) => t.textContent + (t.classList.contains('required') ? '!' : ''))`)],
  [['Client', 'Optional'], ['Client + Server', 'Required!']]);
check('changes formatted', await card(full, `[...c.querySelectorAll('.rel-changes li')].map((l) => l.textContent).concat(c.querySelector('.rel-changes strong').textContent)`),
  ['[Upload to hub] on its own line', 'Join Link in Simple Voice Chat', 'Link']);
check('note', [await card(full, `c.querySelector('.rel-note').textContent`), await card(gone, `!!c.querySelector('.rel-note')`)], ['Note: on Linux, install vlc.', false]);
check('download', await card(full, `[c.querySelector('.rel-download').getAttribute('href'), c.querySelector('.rel-download').getAttribute('download')]`),
  ['/api/file/mods/client/mthub-1.3.1.jar?download=1', 'mthub-1.3.1.jar']);
await settle(500);
check('name and size', await card(full, `c.querySelector('.rel-file-name').textContent`), 'mthub-1.3.1.jar · 2.0 KB');
check('file gone: a muted line, no button', await card(gone, `[c.querySelector('.rel-file').textContent, !!c.querySelector('.rel-download')]`),
  ['waterframes-mt4.jar is no longer in Files', false]);
check('buttons: Readme then Download', await card(full, `[...c.querySelectorAll('.rel-btn')].map((b) => b.textContent)`), ['Readme', 'Download']);
check('no page, no Readme', await card(gone, `c.querySelectorAll('.rel-btn').length`), 0);
check('server-only: just Readme', await card(bare, `[[...c.querySelectorAll('.rel-btn')].map((b) => b.textContent), !!c.querySelector('.rel-download'), c.querySelector('.rel-version')]`),
  [['Readme'], false, null]);
check('the download fetches the jar', (await hub('/api/file/mods/client/mthub-1.3.1.jar?download=1')).status, 200);

// Readme opens the page in Files.
await card(full, `(c.querySelector('.rel-btn').click(), true)`);
await settle(800);
check('readme opens the page', await ev('decodeURIComponent(location.hash)'), '#mods/mod info/MT Hub.md');
await send('Page.navigate', { url: HUB + '/#chan=general' });
await settle(2000);

// Narrow screens: the card fits the chat.
check('fits the message', await card(full, `c.getBoundingClientRect().right <= c.closest('.msg').getBoundingClientRect().right + 1`), true);

// A reply's one-line quote shows the text without marks.
await api('POST', '/api/channels/general/messages', { text: 'nice', reply_to: full }, 'Alex');
await settle(800);
check('reply quote: plain', await ev(`[...document.querySelectorAll('#main-chat .reply-quote .text')].map((t) => t.textContent).pop()`)
  .then((t) => t.startsWith('MT Hub 1.3.1')), true);

await done();
