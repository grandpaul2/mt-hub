// The page fits a phone (measured against the phone's width: a phone browser widens the page
// to its content, so innerWidth alone would hide the problem): nothing wider than the screen at 320–700 px, the top bar's account
// button and the message box's buttons whole, and dialogs inside the screen (the bug sweep
// found the top bar needed 416 px). Chat previews (a video, a wide picture, a sound, a file
// card) are no wider than the message column, so the feed never scrolls sideways; and a
// phone has no time gutter: the time follows the name and the text starts near the edge.
import { api, check, COOKIE, done, ev, HUB, png, send, settle, shot } from './lib.mjs';

for (const [name, body] of [['clip.mp4', 'not a real video'], ['wide.png', png(800, 200, [60, 160, 110])], ['tune.mp3', 'not a real sound'], ['notes.txt', 'text']])
  await fetch(`${HUB}/api/channels/general/media?name=${name}`, { method: 'POST', headers: { cookie: COOKIE.Paul }, body });
const { id: first } = await (await api('POST', '/api/channels/general/messages', { text: 'look #media/general/clip.mp4 #media/general/wide.png #media/general/tune.mp3 #media/general/notes.txt' }, 'Paul')).json();
// A grouped message (no head of its own) and a reply quoting a long line.
await api('POST', '/api/channels/general/messages', { text: 'and a second line from the same person' }, 'Paul');
await api('POST', '/api/channels/general/messages', { text: 'a long first line, the kind a quote has to cut short on a narrow screen, on and on and on' }, 'Paul');
const { id: long } = await (await api('POST', '/api/channels/general/messages', { text: 'again '.repeat(30) }, 'Paul')).json();
await api('POST', '/api/channels/general/messages', { text: 'replying', reply_to: long }, 'Alex');
// The feed's own sideways overflow, and each preview's right edge against the feed's.
const feed = () => ev(`(() => {
  const box = document.querySelector('#chat .messages'), edge = box.getBoundingClientRect().right;
  const wide = [...box.querySelectorAll('.refs > *')].filter((el) => el.getBoundingClientRect().right > edge + 0.5).map((el) => el.className);
  return [box.scrollWidth <= box.clientWidth ? '' : 'feed ' + box.scrollWidth + ' in ' + box.clientWidth, ...wide, box.querySelectorAll('.refs > *').length === 4 ? '' : 'previews missing'].filter(Boolean);
})()`);

const fits = (W) => ev(`(() => {
  const innerWidth = ${W};
  const out = (sel) => { const el = document.querySelector(sel); if (!el) return sel + ' missing'; const r = el.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth + 0.5 ? sel + ' at ' + Math.round(r.left) + '–' + Math.round(r.right) : ''; };
  return [document.documentElement.scrollWidth <= innerWidth ? '' : 'page ' + document.documentElement.scrollWidth,
    out('#user'), out('#search'), out('.compose-row .smile'), out('.compose-row .attach')].filter(Boolean);
})()`);
for (const width of [320, 360, 375, 400, 700]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 700, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: `${HUB}/?w=${width}#chan=general` });
  await settle(1800);
  check(`fits ${width} px`, await fits(width), []);
  check(`chat previews fit ${width} px`, await feed(), []);
  // The picture keeps its 4:1 shape when it shrinks; a grouped message lines up under the
  // first one's text with no time of its own; a reply's quote and the toolbar stay in the feed.
  check(`phone messages at ${width} px`, await ev(`(() => {
    const box = document.querySelector('#chat .messages'), edge = box.getBoundingClientRect().right, at = (el) => el.getBoundingClientRect();
    const head = box.querySelector('.msg[data-id="${first}"]'), next = head.nextElementSibling, img = at(head.querySelector('.ref-pic img'));
    const quote = box.querySelector('.reply-quote'), tools = [...box.querySelectorAll('.msg')].at(-1).querySelector('.msg-tools');
    tools.style.display = 'flex'; const t = at(tools); tools.style.display = '';
    return [Math.abs(img.width / img.height - 4) < 0.1, next.classList.contains('grouped'), ${width < 700} ? getComputedStyle(next.querySelector('.when.side')).display : 'none',
      Math.round(at(next.querySelector('.msg-body')).left - at(head.querySelector('.msg-body')).left), at(quote).left >= 0 && at(quote).right <= edge + 0.5, t.left >= 0 && t.right <= edge + 0.5];
  })()`), [true, true, 'none', 0, true, true]);
  if (width < 700) check(`no time gutter at ${width} px`, await ev(`(() => { const m = [...document.querySelectorAll('#chat .msg:not(.grouped)')].at(-1), at = (sel) => m.querySelector(sel).getBoundingClientRect();
    return [at('.msg-body').left < 30, at('.msg-head .when').left > at('.msg-head .who').right]; })()`), [true, true]);
  if (width === 375) await shot('phone-375');
  // A settings dialog: inside the screen, its close X too.
  await ev(`document.getElementById('user').click()`);
  await settle(200);
  await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent.startsWith('Sound Settings')).click()`);
  await settle(400);
  check(`dialog fits ${width} px`, await ev(`(() => { const innerWidth = ${width}; const r = document.getElementById('dialog').getBoundingClientRect(); const x = document.querySelector('#dialog .close, #dialog [title^="Close"]')?.getBoundingClientRect();
    return [r.left >= 0 && r.right <= innerWidth + 0.5, !!x && x.left >= 0 && x.right <= innerWidth + 0.5]; })()`), [true, true]);
  if (width === 375) await shot('phone-375-dialog');
}
await done();
