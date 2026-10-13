// #voice-link, end to end (docs/voice/svc/hub-link-spec.md): a local LiveKit, the real relay
// (cmd/voicelink) and the real bridge (cmd/voicebridge), both built here, and a stand-in game
// server speaking the relay's protocol. Paul's page: the voice chat is always listed, first,
// with a note until the bridge is in it; a player in the group in game is listed under it
// with their server's tag and lights up while they talk; the game is told when Paul joins;
// the player's menu; the player leaving; the bridge going.
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { api, check, DATA, done, HUB, send, settle, shot } from './lib.mjs';
import { ensureLivekit } from './support/livekit.mjs';

const root = join(import.meta.dirname, '..', '..');
const LK = ensureLivekit();
const freePort = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const [port, tcp, relayPort] = [await freePort(), await freePort(), await freePort()];
const udp = 52600 + Math.floor(Math.random() * 300);
const SECRET = 'test-secret-that-is-long-enough-0123456789';
const TOKENS = { game: 'game-token-0123456789abcdef0123456789abcdef', hub: 'hub-token-0123456789abcdef0123456789abcdef0' };
writeFileSync(join(DATA, 'livekit.yaml'), `port: ${port}
bind_addresses: ["127.0.0.1"]
rtc:
  tcp_port: ${tcp}
  port_range_start: ${udp}
  port_range_end: ${udp + 100}
  use_external_ip: false
  node_ip: 127.0.0.1
keys:
  mthub: ${SECRET}
webhook:
  api_key: mthub
  urls: ["${HUB}/api/voice/webhook"]
`);
writeFileSync(join(DATA, 'voicelink.json'), JSON.stringify({ tokens: { [TOKENS.game]: 'survival', [TOKENS.hub]: 'hub' } }));
writeFileSync(join(DATA, 'voicebridge.json'), JSON.stringify({ relay: `ws://127.0.0.1:${relayPort}/voicelink`, token: TOKENS.hub, livekit: `ws://127.0.0.1:${port}`, key: 'mthub', secret: SECRET, room: 'voice-link' }));
for (const p of ['voicelink', 'voicebridge']) execFileSync('go', ['build', '-o', join(DATA, p), `./cmd/${p}`], { cwd: root, stdio: 'inherit' });
const kids = [];
process.on('exit', () => kids.forEach((k) => k.kill('SIGKILL')));
const run = (cmd, args) => { const p = spawn(cmd, args, { stdio: 'ignore' }); kids.push(p); return p; };
run(LK, ['--config', join(DATA, 'livekit.yaml')]);
run(join(DATA, 'voicelink'), ['-addr', `127.0.0.1:${relayPort}`, '-config', join(DATA, 'voicelink.json')]);
for (let i = 0; i < 50; i++) {
  await settle(100);
  if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) break;
}
const until = async (what, fn, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 150))) if (await fn()) return true;
  console.log(`(timed out waiting for ${what})`);
  return false;
};
const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }))?.result?.value;

// The stand-in game server: Steve is in the group there, and can "talk" (frames of made-up
// bytes with an Opus first byte; nothing in the test listens to them).
const STEVE = '8667ba71b85a4004af54457a9734eed7';
const game = { hub: null, ws: new WebSocket(`ws://127.0.0.1:${relayPort}/voicelink`, { headers: { Authorization: `Bearer ${TOKENS.game}` } }) };
game.ws.binaryType = 'arraybuffer';
await new Promise((ok, no) => { game.ws.onopen = ok; game.ws.onerror = () => no(new Error('the stand-in game server could not reach the relay')); });
game.ws.onmessage = (e) => {
  const b = new Uint8Array(e.data);
  if (b[0] !== 2) return;
  const from = new TextDecoder().decode(b.subarray(2, 2 + b[1]));
  if (from === 'hub') game.hub = JSON.parse(new TextDecoder().decode(b.subarray(2 + b[1]))).members.map((m) => m.name);
};
const roster = (steve) => game.ws.send(new TextEncoder().encode('\x02' + JSON.stringify({ members: steve ? [{ uuid: STEVE.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'), name: 'Steve' }] : [] })));
const talk = (ms) => new Promise((ok) => {
  const id = Uint8Array.from(STEVE.match(/../g).map((x) => parseInt(x, 16)));
  let n = 0;
  const t = setInterval(() => {
    const f = new Uint8Array(17 + 60);
    f[0] = 1; f.set(id, 1);
    for (let i = 18; i < f.length; i++) f[i] = (i * 37 + n * 11) & 255;
    f[17] = 0x78;
    game.ws.send(f);
    if (++n * 20 >= ms) { clearInterval(t); game.ws.send(Uint8Array.from([1, ...id])); ok(); }
  }, 20);
});

const rows = () => ev(`[...document.querySelectorAll('#voice-list > *')].map((r) => r.classList.contains('voice-note') ? '(' + r.textContent + ')' : (r.classList.contains('link') ? '#' : '  ') + r.querySelector('.name').textContent + (r.querySelector('.tag.via') ? ' [' + r.querySelector('.tag.via').textContent + ']' : '') + (r.classList.contains('here') ? '*' : '') + (r.classList.contains('speaking') ? ' (talking)' : ''))`);
const menuOf = async (who) => { await ev(`(() => { const r = [...document.querySelectorAll('#voice-list .row.voice')].find((r) => r.dataset.who === ${JSON.stringify(who)}); const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + 5 })); })()`); await settle(200); const m = await ev(`[...document.getElementById('menu').children].map((c) => c.classList.contains('sep') ? '-' : c.classList.contains('menu-volume') ? 'User Volume' : c.firstChild.textContent)`); await ev(`document.getElementById('menu').hidden = true`); return m; };

// Without link_voice the hub has no such voice chat.
writeFileSync(join(DATA, 'voice.json'), JSON.stringify({ url: `ws://127.0.0.1:${port}`, api: `http://127.0.0.1:${port}`, key: 'mthub', secret: SECRET }));
await send('Page.navigate', { url: HUB });
await until('the page', () => ev(`!!document.getElementById('channels').children.length`));
await settle(500);
check('no #voice-link unless voice.json asks for it', await rows(), []);

// With it: always there, first, with the note (no bridge yet), and outside the limit of 3.
await new Promise((r) => setTimeout(r, 1100)); // (voice.json is read again when its time changes)
writeFileSync(join(DATA, 'voice.json'), JSON.stringify({ url: `ws://127.0.0.1:${port}`, api: `http://127.0.0.1:${port}`, key: 'mthub', secret: SECRET, link_voice: true }));
await send('Page.reload');
await until('the voice chat listed', async () => (await rows()).length > 0);
check('#voice-link is listed with nobody in it, and says the game servers aren’t connected', await rows(), ['#voice-link', '(Not connected to the game servers)']);
check('it is not one of the three', await (async () => { const v = await (await api('GET', '/api/voice', undefined, 'Paul')).json(); return [v.chats.map((c) => c.id), v.full, v.chats[0].link, v.chats[0].linked ?? false]; })(), [['voice-link'], false, true, false]);

// The bridge starts: the note goes. Steve joins the group in game: listed, with his server's tag.
const bridge = run(join(DATA, 'voicebridge'), ['-config', join(DATA, 'voicebridge.json')]);
await until('the bridge in the room', async () => !(await rows()).some((r) => r.startsWith('(')), 20000);
check('the bridge is in: the note is gone', await rows(), ['#voice-link']);
roster(true);
await until('Steve listed', async () => (await rows()).length === 2, 20000);
check('a player in the group in game is listed under it with the server’s tag', await rows(), ['#voice-link', '  Steve [SMP]']);
check('the game is told nobody is in from the hub', game.hub, []);

// Paul joins from the hub: the game is told; Steve talks: his name lights up.
await ev(`document.querySelector('#voice-list .row.voice.link').click()`);
await until('Paul in the voice chat', () => ev(`!document.getElementById('voice-bar').hidden`), 20000);
await until('Paul listed', async () => (await rows()).includes('  Paul*'), 15000);
check('Paul is in it, after the player', await rows(), ['#voice-link*', '  Steve [SMP]*', '  Paul*']);
await until('the game told', async () => game.hub?.length === 1);
check('the game is told Paul joined from the hub', game.hub, ['Paul']);
check('the bar names the voice chat', await ev(`document.querySelector('#voice-bar .voice-where .muted').textContent`), 'voice-link');
const talking = talk(3000);
const lit = await until('Steve’s name lit', async () => (await rows()).includes('  Steve [SMP]* (talking)'), 4000);
check('a player’s name lights up while they talk', lit, true);
await talking;
await shot('talking');
await until('Steve’s name unlit', async () => (await rows()).includes('  Steve [SMP]*'), 8000);
// People read as people: light blurple, a step further in than the voice chat's own name
// (green while talking); the name voice-link itself is neither.
check('people under voice-link: blurple and indented; its name is not', await ev(`(() => { const css = (e, p) => getComputedStyle(e)[p]; const head = document.querySelector('#voice-list .row.voice.link');
  const people = [...document.querySelectorAll('#voice-list .row.voice.voice-more')];
  return [people.length > 0, people.every((r) => ['rgb(201, 205, 251)', 'rgb(115, 201, 145)'].includes(css(r.querySelector('.name'), 'color'))), css(head.querySelector('.name'), 'color') === 'rgb(201, 205, 251)',
    people.every((r) => r.querySelector('.name').getBoundingClientRect().left - head.querySelector('.name').getBoundingClientRect().left === 16)]; })()`), [true, true, false, true]);
check('and goes out when they stop', (await rows()).includes('  Steve [SMP]*'), true);

// A player is not a hub account: their volume for you, and nothing else. Paul's own row: Leave.
check('right-click on the player: Leave, User Volume, Mute', await menuOf('link:survival:Steve'), ['Leave', '-', 'User Volume', 'Mute']);
check('an admin cannot disconnect or mute a player through the hub', [(await api('POST', '/api/voice/voice-link/disconnect', { name: 'link:survival:Steve' }, 'Paul')).status, (await api('POST', '/api/voice/voice-link/mute', { name: 'link:survival:Steve' }, 'Paul')).status], [404, 404]);

// Steve leaves the group; then the bridge goes: Paul stays, the note is back.
roster(false);
await until('Steve gone', async () => !(await rows()).some((r) => r.includes('Steve')), 20000);
check('the player leaving the group leaves the list', await rows(), ['#voice-link*', '  Paul*']);
bridge.kill('SIGTERM');
await until('the note back', async () => (await rows()).some((r) => r.startsWith('(')), 30000);
check('the bridge gone: still a voice chat, and it says so', await rows(), ['#voice-link*', '(Not connected to the game servers)', '  Paul*']);
await ev(`[...document.querySelectorAll('#voice-bar button')].at(-1).click()`);
await until('Paul out', async () => !(await rows()).some((r) => r.includes('Paul')), 15000);
check('everyone gone: #voice-link is still listed', (await rows())[0], '#voice-link');

await done();
