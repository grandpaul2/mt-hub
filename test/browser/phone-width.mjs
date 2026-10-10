// The page fits a phone (measured against the phone's width: a phone browser widens the page
// to its content, so innerWidth alone would hide the problem): nothing wider than the screen at 320–700 px, the top bar's account
// button and the message box's buttons whole, and dialogs inside the screen (the bug sweep
// found the top bar needed 416 px).
import { check, done, ev, HUB, send, settle, shot } from './lib.mjs';

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
