// The Trash: what was moved there in the last 30 days, newest first, in the main panel. Each
// row says what it is, where it was, who moved it and when, and how long it has left. Anyone
// restores (back where it was; a file posted in a chat asks for a folder) or drags a row
// onto a folder in the tree to restore it there. Admins can also Delete Forever, and Empty
// Trash. Files from private chats and DMs are never listed (the hub doesn't send them).
import { iconURL } from './icons';
import { $, ask, baseName, bytes, dateTime, dirName, go, h, isAdmin, json, req, toast, toastError, user } from './util';

export type TrashItem = { id: string; path: string; chat?: string; dir: boolean; size: number; who: string; time: string; replaced?: boolean };
type Hooks = {
  show(): void; // switch the main panel to the Trash
  shown(): boolean;
  restore(ids: string[], to?: string): Promise<void>; // put them back (to: into that folder)
  pickFolder(name: string, done: (dir: string) => void): void; // ask for a folder in Files
  drag(ids: string[]): void; // these rows are being dragged (the tree takes them)
};

let hooks: Hooks;
let items: TrashItem[] = [];
let days = 30;
const count = h('span', { class: 'muted count' });
const empty = h('button', { title: 'Erase everything in the Trash for good' }, 'Empty Trash');
const list = h('div', { class: 'trash-list' });

export function setupTrash(h_: Hooks) {
  hooks = h_;
  $('main-trash').append(
    h('div', { class: 'chat-head shot-bar' }, h('span', {}, 'Trash'), count, h('span', { class: 'spacer' }), empty),
    h('div', { class: 'shot-scroll' }, list));
  empty.onclick = async () => {
    const n = items.length;
    if (!await ask({ title: 'Empty Trash?', body: `${n === 1 ? 'The 1 item in it is' : `All ${n} items in it are`} erased. This can’t be undone.`, confirm: 'Empty Trash', danger: true })) return;
    const r = await req('POST', '/api/trash/empty');
    if (!r.ok) toastError(`Couldn’t empty the Trash: ${(await r.json().catch(() => ({}))).error ?? r.status}.`);
    else toast('Trash emptied');
    refreshTrash();
  };
}

export function openTrash() {
  hooks.show();
  go('#trash');
  return refreshTrash();
}

// refreshTrash reads the Trash again (it changed, here or for someone else) while it shows.
export async function refreshTrash() {
  if (!hooks.shown()) return;
  const r = await req('GET', '/api/trash').catch(() => null);
  if (!r?.ok) return;
  ({ items, days } = await json<{ items: TrashItem[]; days: number }>(r));
  render();
}

// left: "29 days left", from when it was moved there.
function left(it: TrashItem) {
  const n = Math.max(1, Math.ceil((new Date(it.time).getTime() + days * 864e5 - Date.now()) / 864e5));
  return `${n} day${n === 1 ? '' : 's'} left`;
}

function render() {
  const admin = isAdmin(user.name);
  count.textContent = String(items.length);
  empty.hidden = !admin || !items.length;
  if (!items.length) return list.replaceChildren(h('div', { class: 'muted pad' }, `Trash is empty. What you move here stays ${days} days.`));
  list.replaceChildren(...items.map((it) => {
    const name = baseName(it.path);
    const from = it.chat ? `#${it.chat}` : dirName(it.path) ? dirName(it.path) + '/' : 'Files';
    const restore = h('button', { title: it.chat ? 'Put it in a folder in Files' : `Put it back in ${from}` }, 'Restore');
    restore.onclick = () => (it.chat ? hooks.pickFolder(name, (dir) => void hooks.restore([it.id], dir)) : void hooks.restore([it.id]));
    const forever = h('button', { title: 'Erase it for good' }, 'Delete Forever');
    forever.hidden = !admin;
    forever.onclick = async () => {
      if (!await ask({ title: `Delete ${name} forever?`, body: 'It is erased from the Trash. This can’t be undone.', confirm: 'Delete Forever', danger: true })) return;
      const r = await req('POST', '/api/trash/delete', JSON.stringify({ ids: [it.id] }));
      if (!r.ok) toastError(`Couldn’t delete it: ${(await r.json().catch(() => ({}))).error ?? r.status}.`);
      refreshTrash();
    };
    const row = h('div', { class: 'trash-item', title: it.chat ? `${name}, posted in #${it.chat}` : it.path },
      h('img', { class: 'icon', src: iconURL(name, it.dir, false), alt: '', draggable: false }),
      h('div', { class: 'trash-what' },
        h('div', { class: 'trash-name' }, h('span', {}, name + (it.dir ? '/' : '')), it.replaced ? h('span', { class: 'trash-tag' }, 'replaced') : ''),
        h('div', { class: 'trash-meta' }, [`from ${from}`, it.who, dateTime(new Date(it.time)), it.dir ? '' : bytes(it.size), left(it)].filter(Boolean).join(' · '))),
      restore, forever);
    row.dataset.id = it.id;
    // Onto a folder in the tree: restored there.
    row.draggable = true;
    row.ondragstart = (e) => {
      e.dataTransfer?.setData('text/x-mt-trash', it.id);
      hooks.drag([it.id]);
    };
    return row;
  }));
}
