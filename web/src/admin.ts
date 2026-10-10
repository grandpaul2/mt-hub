// The Admin page (a settings dialog, from the menu on your name; style guide 6.8): adding an
// account; every account as a row (name, role badges, online or last seen) with its actions
// behind "⋯" (Reset password, Unlink Minecraft name; Ban and Delete in red, each asking for a
// second click; a deleted account's name can't be used again); a log
// of who did what. All admins see the same page; the owner's menus also have Make Admin and,
// on an admin, Remove Admin. The server enforces who may do what: admins act on members, only
// the owner acts on admins, nobody on the owner.
import { ago, closeMenu, copyText, GLYPH, glyphs, group, h, json, opTag, req, row, settingsDialog, showMenu, TAG_COLOURS, user, type MenuItem } from './util';

type AdminUser = { name: string; admin: boolean; owner: boolean; banned: boolean; seen?: string; online: boolean; tag?: string; mc?: string };
type LogEntry = { t: string; by: string; action: string; user: string };

const ACTIONS: Record<string, string> = {
  ban: 'banned', unban: 'unbanned', reset: 'reset the password of', delete: 'deleted',
  add: 'added', admin: 'made admin', unadmin: 'removed admin from', 'unlink-mc': 'unlinked the Minecraft name of',
  'voice-disconnect': 'disconnected {} from a voice chat', 'voice-mute': 'muted {} for everyone in a voice chat',
};
// logLine is one entry as words: "Steve banned Alex" ({} puts the name mid-sentence).
const logLine = (e: LogEntry) => {
  const did = ACTIONS[e.action] ?? e.action;
  return ` ${e.by} ${did.includes('{}') ? did.replace('{}', e.user) : `${did} ${e.user}`}`;
};

let panel: HTMLElement | null = null; // the open page, if any
let shown: { name: string; password: string } | null = null; // a new password, shown once


export function openAdmin() {
  panel = h('div', { class: 'admin' });
  shown = null;
  settingsDialog('Admin', [panel], () => (panel = null));
  render();
}

// adminChanged: an account changed (anyone's Admin page); redraw if it's open.
export function adminChanged() {
  if (panel?.isConnected) render();
}

async function act(method: string, url: string, body?: object) {
  const r = await req(method, url, body && JSON.stringify(body));
  const out = await r.json().catch(() => ({}));
  if (!r.ok) {
    panel?.querySelector('.admin-error')?.replaceChildren(out.error ?? `Couldn’t do that (${r.status}).`);
    return null;
  }
  return out;
}

async function render() {
  const [users, log] = await Promise.all([
    json<AdminUser[]>(await req('GET', '/api/admin/users')),
    json<LogEntry[]>(await req('GET', '/api/admin/log')),
  ]);
  if (!panel?.isConnected) return;
  const url = (u: AdminUser) => `/api/admin/users/${encodeURIComponent(u.name)}`;

  // A person: name and badges (the same op tag as in chat), and online or when last seen.
  const who = (u: AdminUser) => h('span', { class: 'who' }, h('span', { class: 'name' }, u.name),
    u.owner || u.admin ? opTag(u.tag) : '',
    u.banned ? h('span', { class: 'tag banned' }, 'banned') : '');
  const seen = (u: AdminUser) => (u.online ? h('span', { class: 'online' }, ...glyphs('● online')) : u.seen ? `Last seen ${ago(u.seen)}` : 'Never signed in');
  const reset = (u: AdminUser): MenuItem => ['Reset Password', async () => {
    const out = await act('POST', `${url(u)}/password`);
    if (out) shown = { name: u.name, password: out.password };
    render();
  }, undefined, undefined, { confirm: 'Reset? Click again' }];
  // Anyone can claim a Minecraft name (screenshots are credited by it), so an admin can undo one.
  const unlink = (u: AdminUser): MenuItem[] => (u.mc ? [[`Unlink Minecraft Name (${u.mc})`, () => act('PATCH', url(u), { mc: '' }).then(render)]] : []);
  // more is the "⋯" button that opens a person's actions.
  const more = (u: AdminUser, items: () => MenuItem[]) => {
    const b = h('button', { type: 'button', class: 'icon-btn more', title: `Actions for ${u.name}`, innerHTML: GLYPH.more });
    b.onclick = (e) => {
      const r = b.getBoundingClientRect();
      showMenu({ ...e, clientX: r.left, clientY: r.bottom + 2 } as MouseEvent, items(), b);
    };
    return b;
  };

  // Accounts: members can be acted on here; admins and the owner in the Admins group.
  const name = h('input', { placeholder: 'Name', spellcheck: false, maxLength: 32 });
  name.setAttribute('aria-label', 'New account name');
  const add = h('form', { class: 'add-user' }, name, h('button', { class: 'primary', type: 'submit' }, 'Add account'));
  add.onsubmit = async (e) => {
    e.preventDefault();
    const out = await act('POST', '/api/admin/users', { name: name.value.trim() });
    if (!out) return;
    shown = { name: name.value.trim(), password: out.password };
    render();
  };
  // A password just made: shown once, to copy and send to them.
  const pwBox = shown
    ? h('div', { class: 'new-pw' },
      h('div', {}, `Password for ${shown.name}: `, h('code', {}, shown.password), ' ',
        h('button', { type: 'button', onclick: () => copyText(shown!.password) }, 'Copy')),
      h('div', { class: 'muted' }, 'Send it to them. It isn’t shown again; at their first login they choose their own.'))
    : '';
  // well is an admin's tag colour: a swatch that opens the colours to pick from. You can change
  // your own; the owner can change anyone's.
  const well = (u: AdminUser) => {
    const b = h('button', { type: 'button', class: `tag-well t-${u.tag ?? 'purple'}`, title: `Tag colour${u.name === user.name ? '' : ` for ${u.name}`}` });
    b.setAttribute('aria-label', b.title);
    b.onclick = (e) => {
      const swatches = h('div', { class: 'tag-swatches' }, ...TAG_COLOURS.map((c) => {
        const s = h('button', { type: 'button', class: `tag-swatch t-${c}`, title: c[0].toUpperCase() + c.slice(1) });
        s.setAttribute('aria-pressed', String(c === (u.tag ?? 'purple')));
        s.onclick = async () => {
          closeMenu();
          if (await act('PUT', `${url(u)}/tag`, { tag: c })) render();
        };
        return s;
      }));
      const r = b.getBoundingClientRect();
      showMenu({ ...e, clientX: r.left, clientY: r.bottom + 2 } as MouseEvent, [swatches], b);
    };
    return b;
  };
  const canTag = (u: AdminUser) => (u.owner || u.admin) && (u.name === user.name || user.owner);

  // Each person's controls: their tag colour (admins; yours, or anyone's for the owner) and
  // "⋯" with what you may do to them. Admins act on members; the owner on admins too.
  const accounts = users.map((u) => {
    const control: (Node | string)[] = [];
    if (canTag(u)) control.push(well(u));
    if (u.name !== user.name && !u.owner && !u.admin) {
      control.push(more(u, () => [
        reset(u),
        ...unlink(u),
        ...(user.owner && !u.banned ? [['Make Admin', () => act('PATCH', url(u), { admin: true }).then(render)] as MenuItem] : []),
        null,
        u.banned
          ? ['Unban', () => act('PATCH', url(u), { banned: false }).then(render)]
          : ['Ban', () => act('PATCH', url(u), { banned: true }).then(render), undefined, undefined, { danger: true, confirm: 'Ban? Click again' }],
        ['Delete', () => act('DELETE', url(u)).then(render), undefined, undefined, { danger: true, confirm: 'Delete? Their name is retired. Click again' }],
      ]));
    } else if (u.name !== user.name && u.admin && !u.owner && user.owner) {
      // An admin, for the owner: reset (an admin account someone else got into), or remove
      // admin. To ban or delete an admin, remove admin first.
      control.push(more(u, () => [reset(u), ...unlink(u), null, ['Remove Admin', () => act('PATCH', url(u), { admin: false }).then(render)]]));
    }
    // No "⋯": keep its space, so the colour wells line up.
    if (control.length && !control.some((c) => c instanceof HTMLElement && c.classList.contains('more'))) control.push(h('span', { class: 'more-slot' }));
    const r = row(who(u), seen(u), control);
    r.dataset.user = u.name;
    if (u.banned) r.classList.add('is-banned');
    return r;
  });

  const entries = log.length
    ? log.map((e) => h('li', {}, h('span', { class: 'when' }, ago(e.t)), logLine(e)))
    : [h('li', { class: 'muted' }, 'Nothing yet.')];

  panel.replaceChildren(
    h('div', { class: 'admin-error error' }),
    group(`Accounts · ${users.length}`, add, pwBox, ...accounts),
    group('Recent activity', h('ul', { class: 'admin-log' }, ...entries)),
  );
}
