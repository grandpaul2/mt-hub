// Accounts: the login form, the server deciding who you are, changing your password, logging out.
import { api, check, COOKIE, done, ev, HUB, send, settle, shot } from './lib.mjs';

const status = (path, headers = {}) => fetch(HUB + path, { headers }).then((r) => r.status);
const dialogShown = () => ev(`!document.getElementById('overlay').hidden && document.querySelector('#dialog h2')?.textContent`);
const fill = (labels) => ev(`(() => {
  const inputs = [...document.querySelectorAll('#dialog input')];
  ${JSON.stringify(labels)}.forEach((v, i) => { inputs[i].value = v; });
  document.querySelector('#dialog form').requestSubmit();
})()`);

// Logged out, the API refuses everything but /api/login, and the page shows only the form.
check('API needs a login', [await status('/api/tree'), await status('/api/events'), await status('/api/file/README.md')], [401, 401, 401]);
check('a forged session fails', await status('/api/tree', { cookie: 'mt_session=UGF1bA.9999999999.forged' }), 401);
await send('Network.clearBrowserCookies');
await send('Page.navigate', { url: HUB });
await settle(1500);
check('login form', [await dialogShown(), await ev(`document.getElementById('user').hidden`), await ev(`document.title`)], ['MacroTech', true, 'MacroTech']);
await shot('form');

await fill(['Steve', 'nope']);
await settle(1500);
check('wrong password', [await dialogShown(), await ev(`document.querySelector('#dialog .error').textContent`)], ['MacroTech', 'wrong name or password']);
await fill(['Steve', 'Steve-password']);
await settle(1500);
check('logged in', [await dialogShown(), await ev(`document.getElementById('user').textContent`)], [false, 'Steve']);
check('tree loaded', await ev(`document.querySelectorAll('#tree .row').length > 0`), true);

// The name on your changes comes from the session; a header can't claim someone else.
await fetch(`${HUB}/api/channels/general/messages`, { method: 'POST', body: JSON.stringify({ text: 'who am i' }), headers: { cookie: COOKIE.Steve, 'X-MT-User': 'Paul' } });
const last = (await (await api('GET', '/api/channels/general/messages')).json()).pop();
check('message author is the session', [last.text, last.user], ['who am i', 'Steve']);
check('accounts and roles', await (await api('GET', '/api/users')).json(),
  [{ name: 'Alex', admin: false }, { name: 'Paul', admin: true, tag: 'gold' }, { name: 'Steve', admin: false }]);
check('non-admin refused', (await api('DELETE', '/api/channels/general', undefined, 'Steve')).status, 403);

// Change password from the menu on your name: other sessions end, this one carries on.
await ev(`document.getElementById('user').click()`);
await settle(200);
check('account menu', await ev(`[...document.querySelectorAll('#menu button span:first-child')].map((s) => s.textContent)`), ['Keyboard Shortcuts', 'Voice Settings', 'Sound Settings', 'Change Password', 'Log Out', 'Log Out Everywhere']);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent.startsWith('Change')).click()`);
await settle(200);
await fill(['Steve-password', 'short', 'short']);
await settle(300);
check('too short', await ev(`document.querySelector('#dialog .error').textContent`), 'use at least 8 characters');
await fill(['Steve-password', 'new-password-1', 'new-password-2']);
await settle(300);
check('mismatch', await ev(`document.querySelector('#dialog .error').textContent`), 'The new passwords don’t match');
await fill(['Steve-password', 'new-password-1', 'new-password-1']);
await settle(500);
check('changed', [await dialogShown(), await ev(`document.getElementById('toast').textContent`)], [false, 'Password changed. You’re logged out everywhere else.']);
check('old session ended', await status('/api/me', { cookie: COOKIE.Steve }), 401);
check('this tab still in', await ev(`fetch('/api/me').then((r) => r.json()).then((m) => m.name)`), 'Steve');

// A member can't set their own Minecraft name: an admin gives it, in Admin (the admin suite),
// so the menu has no such item and the hub refuses the old page's request.
check('a member’s own Minecraft name is refused', await ev(`fetch('/api/mc', { method: 'POST', body: JSON.stringify({ mc: 'Steve_MC' }) }).then(async (r) => [r.status, (await r.json()).error])`),
  [403, 'An admin sets your Minecraft name: ask one.']);

// Log Out Everywhere: a copy of this session elsewhere ends; this tab stays in.
const here = (await send('Network.getCookies', { urls: [HUB] })).cookies.find((c) => c.name === 'mt_session').value;
await ev(`document.getElementById('user').click()`);
await settle(200);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent === 'Log Out Everywhere').click()`);
await settle(500);
check('logged out everywhere', [await ev(`document.getElementById('toast').textContent`), await status('/api/me', { cookie: `mt_session=${here}` }),
  await ev(`fetch('/api/me').then((r) => r.json()).then((m) => m.name)`)], ['Logged out everywhere else.', 401, 'Steve']);

// Log out: back to the form.
await ev(`document.getElementById('user').click()`);
await settle(200);
await ev(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent === 'Log Out').click()`);
await settle(1500);
check('logged out', [await dialogShown(), await ev(`fetch('/api/me').then((r) => r.status)`)], ['MacroTech', 401]);

await done();
