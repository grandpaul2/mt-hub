// Commands: a message that starts with / and names one of these isn't posted. It runs, and
// its answer is drawn in the chat for you alone, with a Dismiss (chat.ts: private replies).
// The message box offers them as you type (autocomplete.ts).
import { ago, h, json, req, time } from './util';

export type Command = { name: string; about: string; run: () => Promise<HTMLElement> };

export const COMMANDS: Command[] = [
  { name: 'serverstatus', about: 'Players, mspt and memory', run: serverStatus },
];

// commandIn is the command a message is, if it's nothing but one.
export function commandIn(text: string): Command | null {
  const m = /^\/([a-z]+)$/i.exec(text.trim());
  return (m && COMMANDS.find((c) => c.name === m[1].toLowerCase())) || null;
}

// ---- /serverstatus ----

// What the hub knows of one game server (internal/server/status.go).
type ServerStatus = {
  name: string; up: boolean; seen?: string; players: string[]; bots: number;
  mspt: number; peak: number; mem_used: number; mem_max: number; hist: [number, number][];
};

const WINDOW = 600; // seconds the graph covers
const BEHIND = 50; // mspt above this and the server falls behind
const GAP = 25; // seconds without a report: the line breaks

async function serverStatus(): Promise<HTMLElement> {
  const r = await req('GET', '/api/server-status');
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? String(r.status));
  const servers = await json<ServerStatus[]>(r);
  const card = h('div', { class: 'st-card' }, h('div', { class: 'st-label' }, 'Server status'));
  if (!servers.length) {
    card.append(h('div', { class: 'st-none' }, 'No game servers are linked to the hub.'));
    return card;
  }
  card.append(...servers.map(serverBlock), h('div', { class: 'st-foot' }, `Last 10 minutes, as of ${time(new Date())}`));
  return card;
}

function serverBlock(s: ServerStatus): HTMLElement {
  const name = s.name.charAt(0).toUpperCase() + s.name.slice(1);
  const head = (count: string) => h('div', { class: 'st-head' }, h('span', { class: 'st-dot' + (s.up ? '' : ' off') }), h('span', { class: 'st-name' }, name),
    h('span', { class: 'st-count' }, count));
  if (!s.up) return h('div', { class: 'st-srv down' }, head(s.seen ? `Offline · last seen ${ago(s.seen)}` : 'Offline'));
  const bots = s.bots ? `${s.bots} bot${s.bots === 1 ? '' : 's'}` : '';
  const who = [s.players.join(', '), bots].filter(Boolean).join(' + ') || 'Nobody online';
  const gb = (n: number) => (n / 2 ** 30).toFixed(1);
  const max = gb(s.mem_max).replace(/\.0$/, '');
  return h('div', { class: 'st-srv' }, head(`${s.players.length} online`), h('div', { class: 'st-who' }, who),
    h('div', { class: 'st-rows' },
      h('span', { class: 'st-key' }, 'mspt'), h('div', { class: 'st-graph', innerHTML: spark(s.hist) }),
      h('span', { class: 'st-val' }, h('span', { class: 'st-num' + (s.mspt >= BEHIND ? ' bad' : '') }, s.mspt.toFixed(1)), h('small', {}, ` peak ${s.peak.toFixed(1)}`)),
      h('span', { class: 'st-key' }, 'Memory'),
      h('div', { class: 'st-bar' }, h('i', { style: `width:${s.mem_max ? Math.min(100, (100 * s.mem_used) / s.mem_max) : 0}%` })),
      h('span', { class: 'st-val st-num' }, gb(s.mem_used), h('small', {}, ` / ${max} GB`))));
}

// spark draws mspt over the last ten minutes, newest on the right, with a dashed line at 50.
// The scale tops out at 80 (more if it went higher), so that line sits in the same place for
// every server.
function spark(hist: [number, number][]) {
  const top = Math.max(80, ...hist.map(([, v]) => v * 1.1));
  const x = (secs: number) => (100 - (Math.min(secs, WINDOW) / WINDOW) * 100).toFixed(1);
  const y = (v: number) => (26 - (Math.min(v, top) / top) * 24).toFixed(1);
  const lines: string[] = [];
  let run: string[] = [];
  let last = Infinity;
  const end = () => {
    // one report on its own still shows: a short flat stroke
    if (run.length === 1) run.push(run[0].replace(/^[\d.]+/, (n) => String(Math.max(0, +n - 1))));
    if (run.length) lines.push(`<polyline class="st-line" points="${run.join(' ')}"/>`);
    run = [];
  };
  for (const [secs, v] of hist) {
    if (last - secs > GAP) end();
    run.push(`${x(secs)},${y(v)}`);
    last = secs;
  }
  end();
  return `<svg viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><line class="st-limit" x1="0" x2="100" y1="${y(BEHIND)}" y2="${y(BEHIND)}"/>${lines.join('')}</svg>`;
}
