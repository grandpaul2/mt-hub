// Old #chan= links and the saved side panel follow chat renames and deletes.
import { api, check, done, ev, HUB, send, settle, ws } from './lib.mjs';

await api('POST', '/api/channels', { name: 'builds' });
await api('POST', '/api/channels', { name: 'redstone' });
await api('POST', '/api/channels/builds/messages', { text: 'new farm is up' });

await send('Runtime.enable');
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') console.log('  PAGE EXCEPTION:', m.params.exceptionDetails.exception?.description?.split('\n').slice(0, 3).join(' | '));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') console.log('  PAGE ERROR:', m.params.args.map((a) => a.value ?? a.description).join(' '));
});
const paul = (method, path, body) => api(method, path, body, 'Paul');
await paul('POST', '/api/channels/builds/messages', { text: 'old link test' });
await paul('PATCH', '/api/channels/builds', { name: 'farms' });
const visit = async (hashPart, side) => {
  await send('Page.navigate', { url: 'about:blank' });
  await settle(200);
  await send('Page.navigate', { url: HUB + '/' });
  await settle(500);
  await ev(`localStorage.setItem('mt-chat-side', '${side}')`);
  await send('Page.navigate', { url: `${HUB}/?visit=${Math.random()}${hashPart}` });
  await settle(2000);
  return ev(`[decodeURIComponent(location.hash), document.getElementById('main-chat-title').textContent, document.getElementById('chat-select').value]`);
};
check('old link + saved side pane follow rename', await visit('#chan=builds', 'builds'), ['#chan=farms', '# farms', 'farms']);
check('old messages there', await ev(`[...document.querySelectorAll('#main-chat-body .msg-body')].map((m) => m.textContent)`), ['new farm is up', 'old link test']);
await paul('PATCH', '/api/channels/farms', { name: 'farm-builds' });
check('chain of renames', await visit('#chan=builds', 'general'), ['#chan=farm-builds', '# farm-builds', 'general']);
await paul('POST', '/api/channels', { name: 'builds' });
await paul('POST', '/api/channels', { name: 'builds' });
check('reused name wins', await visit('#chan=builds', 'general'), ['#chan=builds', '# builds', 'general']);
await paul('DELETE', '/api/channels/redstone');
check('deleted chat falls back to first', (await visit('#chan=redstone', 'redstone'))[2], 'builds');

await done();
