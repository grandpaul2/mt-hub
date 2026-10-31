// Link previews in chat (needs the internet): cards, <link> opt-out, YouTube click-to-play.
import { api, check, done, ev, HUB, send, settle, shot } from './lib.mjs';

const post = (text, who) => api('POST', '/api/channels/general/messages', { text }, who);
await post('the hopper page https://minecraft.wiki/w/Hopper');
await post('carpet https://modrinth.com/mod/carpet and no preview for <https://github.com/gnembon/fabric-carpet> please', 'Pat');
await post('https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png');
await post('watch this https://youtu.be/dQw4w9WgXcQ');
await send('Page.navigate', { url: HUB });
await settle(500);
await ev(`localStorage.setItem('mt-chat-hidden','1')`);
await send('Page.navigate', { url: HUB + '/?r=2#chan=general' });
await settle(4000);
const cards = () => ev(`[...document.querySelectorAll('#main-chat .msg')].map((m) => [...m.querySelectorAll('.embed, .embed-image')].map((e) => e.classList.contains('embed-image') ? 'image' : (e.querySelector('.embed-site')?.textContent ?? '?')))`);
check('cards per message', await cards(), [['Minecraft Wiki'], ['Modrinth'], ['image'], ['YouTube']]);
check('<link> shows without brackets', await ev(`[...document.querySelectorAll('#main-chat .msg-body')][1].textContent`), 'carpet https://modrinth.com/mod/carpet and no preview for https://github.com/gnembon/fabric-carpet please');
check('scrolled to bottom after cards', await ev(`(() => { const b = document.querySelector('#main-chat .messages'); return b.scrollHeight - b.scrollTop - b.clientHeight < 60; })()`), true);
await shot('embeds');
await ev(`document.querySelector('#main-chat .embed-play').click()`);
await settle(500);
const frame = await ev(`(() => { const f = document.querySelector('#main-chat iframe.embed-video'); window.__frame = f; return f?.src; })()`);
check('click plays in place', frame, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1');
await post('nice');
await settle(800);
check('video survives a new message', await ev(`document.querySelector('#main-chat iframe.embed-video') === window.__frame && window.__frame.isConnected`), true);
check('new message shown', await ev(`[...document.querySelectorAll('#main-chat .msg-body')].pop().textContent`), 'nice');
await settle(2500);
await shot('embeds-playing');

await done();
