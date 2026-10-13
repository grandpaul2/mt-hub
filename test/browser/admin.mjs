// The Admin page: a ban throws an open page back to the login form at once, and the
// owner's page bans, unbans, resets, adds and logs.
import { api, as, check, COOKIE, done, ev, hub, HUB, key, send, settle, shot } from './lib.mjs';

const status = (path, who) => fetch(HUB + path, { headers: { cookie: COOKIE[who] } }).then((r) => r.status);
const patch = (name, body, who = 'Paul') =>
  fetch(`${HUB}/api/admin/users/${name}`, { method: 'PATCH', body: JSON.stringify(body), headers: { cookie: COOKIE[who] } });
const menu = async () => {
  await ev(`document.getElementById('user').click()`);
  await settle(200);
  const items = await ev(`[...document.querySelectorAll('#menu button span:first-child')].map((s) => s.textContent)`);
  await ev(`document.getElementById('user').click()`); // close it again
  return items;
};
const loginForm = () => ev(`!document.getElementById('overlay').hidden && document.querySelector('#dialog h2')?.textContent === 'MacroTech'
  && document.querySelector('#dialog .error').textContent`);
// The Admin dialog's groups by heading; a person's row in one (Accounts by default).
const section = (title) => `[...document.querySelectorAll('.admin section')].find((g) => g.querySelector('h3').textContent.startsWith(${JSON.stringify(title)}))`;
const row = (name, where = 'Accounts') => `${section(where)}.querySelector('[data-user=${JSON.stringify(name)}]')`;
// A row as "name tags | presence | control", where the control is "⋯" (a menu), "colour" (the
// admin tag's colour well), or buttons.
const rowText = (name, where) => ev(`(() => { const r = ${row(name, where)}; if (!r) return null;
  const control = [...r.querySelector('.set-control').children].filter((c) => !c.classList.contains('more-slot')).map((c) => c.classList.contains('more') ? '⋯' : c.classList.contains('tag-well') ? 'colour' : c.textContent).join(' ');
  return [[...r.querySelectorAll('.name, .tag')].map((e) => e.textContent).join(' '), r.querySelector('.set-sub').textContent, control].join(' | '); })()`);
// Every Accounts row without its presence (it differs by viewer).
const tableRows = () => ev(`[...${section('Accounts')}.querySelectorAll('[data-user]')].map((r) =>
  [...r.querySelectorAll('.name, .tag')].map((e) => e.textContent).concat([...r.querySelector('.set-control').children].filter((c) => !c.classList.contains('more-slot')).map((c) => c.classList.contains('more') ? '⋯' : c.classList.contains('tag-well') ? 'colour' : c.textContent)).join(' '))`);
// A person's "⋯" menu: its items as "label" or "label (red)"; act clicks one (the menu stays
// open on an item that asks for a second click).
const openMore = async (name, where) => {
  await ev(`${row(name, where)}.querySelector('.more').click()`);
  await settle(200);
};
const items = () => ev(`[...document.querySelectorAll('#menu button')].map((b) => b.firstChild.textContent + (b.classList.contains('danger') ? ' (red)' : ''))`);
const act = (label) => ev(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === ${JSON.stringify(label)}).click()`);
const closeMenu = () => key('Escape');

// Steve, with the hub open, sees no Admin entry.
await as('Steve');
await send('Page.navigate', { url: HUB });
await settle(1500);
check('member menu', await menu(), ['Keyboard Shortcuts', 'Voice Settings', 'Sound Settings', 'Change Password', 'Log Out', 'Log Out Everywhere']);
check('member refused', await status('/api/admin/users', 'Steve'), 403);

// Banned from elsewhere: his open page drops to the login form, saying why.
await patch('Steve', { banned: true });
await settle(1500);
check('banned page', await loginForm(), 'this account is banned');
check('banned api', await status('/api/me', 'Steve'), 401);
await ev(`(() => { const i = document.querySelectorAll('#dialog input'); i[0].value = 'Steve'; i[1].value = 'Steve-password'; document.querySelector('#dialog form').requestSubmit(); })()`);
await settle(500);
check('banned login', await loginForm(), 'this account is banned');
await shot('banned');

// The owner's Admin page.
await as('Paul');
await send('Page.navigate', { url: HUB });
await settle(1500);
check('owner menu', await menu(), ['Admin', 'Keyboard Shortcuts', 'Voice Settings', 'Sound Settings', 'Change Password', 'Log Out', 'Log Out Everywhere']);
await ev(`document.getElementById('user').click()`);
await settle(200);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent.startsWith('Admin')).click()`);
await settle(700);
check('rows', [await rowText('Alex'), await rowText('Paul'), await rowText('Steve')], [
  'Alex | No Minecraft name · Never signed in | ⋯',
  'Paul op | No Minecraft name · ● online | colour ⋯',
  'Steve banned | No Minecraft name · Last seen just now | ⋯',
]);
check('a settings dialog: title, close X, groups', [await ev(`document.querySelector('#dialog .dialog-head h2').textContent`), await ev(`document.querySelector('#dialog .dialog-x').title`),
  await ev(`[...document.querySelectorAll('.admin section h3')].map((h) => h.textContent)`)], ['Admin', 'Close (Esc)', ['Accounts · 3', 'Recent activity']]);
await openMore('Alex');
check('a member’s menu (owner): Make Admin; Ban and Delete in red', await items(), ['Reset Password', 'Minecraft Name…', 'Make Admin', 'Ban (red)', 'Delete (red)']);
await closeMenu();
await shot('page');

// Unban is one click; ban needs two (a stray click does nothing), the menu staying open.
await openMore('Steve');
check('a banned member’s menu', await items(), ['Reset Password', 'Minecraft Name…', 'Unban', 'Delete (red)']);
await act('Unban');
await settle(500);
check('unbanned', [await status('/api/me', 'Steve'), await rowText('Steve')], [200, 'Steve | No Minecraft name · ● online | ⋯']);
await openMore('Alex');
await act('Ban');
await settle(300);
check('one click arms', [await items(), await ev(`!document.getElementById('menu').hidden`), await status('/api/me', 'Alex')], [['Reset Password', 'Minecraft Name…', 'Make Admin', 'Ban? Click again (red)', 'Delete (red)'], true, 200]);
await act('Ban? Click again');
await settle(500);
check('two clicks ban', [await status('/api/me', 'Alex'), await rowText('Alex'), await ev(`document.getElementById('menu').hidden`)], [401, 'Alex banned | No Minecraft name · Last seen just now | ⋯', true]);

// Reset: a temporary password shown once, which logs in.
await openMore('Steve');
await act('Reset Password');
await settle(100);
await act('Reset? Click again');
await settle(500);
const pw = await ev(`document.querySelector('.new-pw code')?.textContent`);
const login = await fetch(`${HUB}/api/login`, { method: 'POST', body: JSON.stringify({ name: 'Steve', password: pw }) });
check('temp password works', [/^\w{4}-\w{4}-\w{4}$/.test(pw), login.status, await status('/api/me', 'Steve')], [true, 200, 401]);

// Add an account.
await ev(`(() => { const [name, mc] = document.querySelectorAll('.add-user input'); name.value = 'Herobrine'; mc.value = 'Hero_brine'; document.querySelector('.add-user').requestSubmit(); })()`);
await settle(500);
check('added', [await ev(`document.querySelector('.new-pw').innerText.split('\\n')[0].replace(/:.*/, '')`), await rowText('Herobrine')],
  ['Password for Herobrine', 'Herobrine | Minecraft: Hero_brine · Never signed in | ⋯']);
await ev(`(() => { document.querySelector('.add-user input').value = 'herobrine'; document.querySelector('.add-user').requestSubmit(); })()`);
await settle(500);
check('taken name', await ev(`document.querySelector('.admin-error').textContent`), 'that name is taken');

// Minecraft names are an admin's to give: with the account (above), and from a person's "⋯",
// typed in their row. Enter saves, an empty box takes it away, Esc leaves it (and Admin open).
const mcBox = `document.querySelector('.admin .mc-form input')`;
const nameIt = async (who, value, how = 'submit') => {
  await openMore(who);
  await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.firstChild.textContent === 'Minecraft Name…').click()`);
  await settle(300);
  const had = await ev(`[${mcBox}.value, ${mcBox}.closest('.set-row').dataset.user, document.activeElement === ${mcBox}]`);
  await ev(`${mcBox}.value = ${JSON.stringify(value)}`);
  if (how === 'submit') await ev(`${mcBox}.form.requestSubmit()`);
  else { await ev(`${mcBox}.focus()`); await key('Escape'); }
  await settle(500);
  return had;
};
check('Minecraft Name… opens a box in their row, with the name, focused', await nameIt('Herobrine', 'Hero2'), ['Hero_brine', 'Herobrine', true]);
check('Enter saves it', [await rowText('Herobrine'), (await (await hub('/api/admin/users')).json()).find((u) => u.name === 'Herobrine').mc], ['Herobrine | Minecraft: Hero2 · Never signed in | ⋯', 'Hero2']);
await nameIt('Herobrine', 'not a name!');
check('not a Minecraft name: said, and the box stays', [await ev(`document.querySelector('.admin-error').textContent`), await ev(`!!${mcBox}`)], ['that isn’t a Minecraft name: 3 to 16 letters, digits and _', true]);
await ev(`${mcBox}.focus()`);
await key('Escape');
await settle(300);
check('Esc closes the box, not Admin; the name is as it was', [await ev(`!!${mcBox}`), await ev(`!document.getElementById('overlay').hidden`), await rowText('Herobrine')], [false, true, 'Herobrine | Minecraft: Hero2 · Never signed in | ⋯']);
await nameIt('Paul', 'hero2');
check('a name someone has is refused', await ev(`document.querySelector('.admin-error').textContent`), 'another account has that Minecraft name');
await ev(`${mcBox}.value = 'Paul_mc'; ${mcBox}.form.requestSubmit()`);
await settle(500);
check('your own row has it too', await rowText('Paul'), 'Paul op | Minecraft: Paul_mc · ● online | colour ⋯');
await nameIt('Herobrine', '');
check('an empty box takes the name away', await rowText('Herobrine'), 'Herobrine | No Minecraft name · Never signed in | ⋯');

check('log', await ev(`[...document.querySelectorAll('.admin-log li')].map((l) => l.textContent.replace(/^.*? Paul/, 'Paul'))`), [
  'Paul took away the Minecraft name of Herobrine', 'Paul set the Minecraft name of Paul', 'Paul set the Minecraft name of Herobrine',
  'Paul added Herobrine', 'Paul reset the password of Steve', 'Paul banned Alex', 'Paul unbanned Steve', 'Paul banned Steve',
]);
await shot('after');

// Make Herobrine an admin from his menu (owner only); an admin's menu then has Remove Admin.
const herobrinePw = await ev(`document.querySelector('.new-pw code').textContent`);
await openMore('Herobrine');
await act('Make Admin');
await settle(500);
check('made admin', await rowText('Herobrine'), 'Herobrine op | No Minecraft name · Never signed in | colour ⋯');
await openMore('Herobrine');
check('an admin’s menu (owner)', await items(), ['Reset Password', 'Minecraft Name…', 'Remove Admin']);
await closeMenu();
const table = await tableRows();
check('owner table: the same tag as chat; a colour well on every admin (the owner can change anyone’s)', table, ['Alex banned ⋯', 'Herobrine op colour ⋯', 'Paul op colour ⋯', 'Steve ⋯']);
check('default tag colours: gold for the owner, purple for admins', await ev(`[...${section('Accounts')}.querySelectorAll('.tag.op')].map((t) => t.className)`), ['tag op t-purple', 'tag op t-gold']);
// Picking a colour: the well opens the swatches (the current one marked); a click saves it.
await ev(`${row('Herobrine')}.querySelector('.tag-well').click()`);
await settle(200);
check('swatches: nine colours, purple marked', await ev(`[[...document.querySelectorAll('#menu .tag-swatch')].length, document.querySelector('#menu .tag-swatch[aria-pressed=true]').title]`), [9, 'Purple']);
await shot('swatches');
await ev(`document.querySelector('#menu .tag-swatch.t-teal').click()`);
await settle(600);
check('Herobrine’s tag is teal, here and for everyone', [await ev(`${row('Herobrine')}.querySelector('.tag.op').className`),
  (await (await api('GET', '/api/users', undefined, 'Paul')).json()).find((a) => a.name === 'Herobrine').tag], ['tag op t-teal', 'teal']);
// The chat behind redraws: Paul's tag on his message turns green when he picks green.
await api('POST', '/api/channels/general/messages', { text: 'tag test' }, 'Paul');
await settle(500);
const chatTag = () => ev(`[...document.querySelectorAll('.msg-head .tag.op')].map((t) => t.className).at(-1)`);
check('chat: the owner’s tag is gold', await chatTag(), 'tag op t-gold');
await api('PUT', '/api/admin/users/Paul/tag', { tag: 'green' }, 'Paul');
await settle(800);
check('chat: green once he picks it, without a reload', await chatTag(), 'tag op t-green');
await shot('owner');

// Herobrine's Admin page: the same table, the same Add bar, no Owner section.
const r = await fetch(`${HUB}/api/login`, { method: 'POST', body: JSON.stringify({ name: 'Herobrine', password: herobrinePw }) });
const tempCookie = r.headers.getSetCookie()[0].split(';')[0];
await send('Network.setCookie', { name: 'mt_session', value: tempCookie.split('=')[1], url: HUB });
await send('Page.navigate', { url: HUB });
await settle(1500);
// A temporary password: nothing works until Herobrine picks their own, and the dialog asking
// for it can't be closed.
check('temp password: the API waits', (await fetch(`${HUB}/api/tree`, { headers: { cookie: tempCookie } })).status, 403);
check('must choose a password', [await ev(`document.querySelector('#dialog h2').textContent`), await ev(`[...document.querySelectorAll('#dialog button')].map((b) => b.textContent)`)],
  ['Choose your password', ['Change']]);
await key('Escape');
check('Esc doesn’t close it', await ev(`!document.getElementById('overlay').hidden`), true);
await ev(`(() => { const i = document.querySelectorAll('#dialog input'); i[0].value = ${JSON.stringify(herobrinePw)}; i[1].value = i[2].value = 'herobrine-own-pw'; document.querySelector('#dialog form').requestSubmit(); })()`);
await settle(1000);
check('then the hub opens', [await ev(`document.getElementById('overlay').hidden`), await ev(`document.querySelectorAll('#tree .row').length > 0`)], [true, true]);
await ev(`document.getElementById('user').click()`);
await settle(200);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent.startsWith('Admin')).click()`);
await settle(700);
check('admin sees the same table (their own colour well and their own Minecraft name; no menu on other admins)', await tableRows(), ['Alex banned ⋯', 'Herobrine op colour ⋯', 'Paul op', 'Steve ⋯']);
check('admin page', [await ev(`!!${section('Admins')}`), await ev(`document.querySelector('.add-user').innerText.trim()`)], [false, 'Add account']);
await shot('admin-view');

// Back as the owner: remove admin.
await as('Paul');
await send('Page.navigate', { url: HUB });
await settle(1500);
check('remove admin', (await fetch(`${HUB}/api/admin/users/Herobrine`, { method: 'PATCH', body: JSON.stringify({ admin: false }), headers: { cookie: COOKIE.Paul } })).status, 200);

await done();
