// Fetches the MediaMTX server the relay suite runs, once, into fetched/ (not in git), with its
// checksum checked; the same way as support/livekit.mjs. Linux x86-64 only.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..', '..');
export const MTX = join(root, 'fetched', 'mediamtx');
const MTX_VERSION = '1.20.1';

export function ensureMediamtx() {
  if (existsSync(MTX)) return MTX;
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(`the relay suite needs Linux x86-64 to run MediaMTX ${MTX_VERSION} (this is ${process.platform} ${process.arch}); skip it: node test/browser/run.mjs <the other suites>`);
  }
  const fetched = join(root, 'fetched');
  mkdirSync(fetched, { recursive: true });
  const tmp = mkdtempSync(join(fetched, 'mediamtx-tmp-'));
  try {
    const base = `https://github.com/bluenviron/mediamtx/releases/download/v${MTX_VERSION}`;
    const tar = `mediamtx_v${MTX_VERSION}_linux_amd64.tar.gz`;
    execFileSync('sh', ['-ec', `cd "$1" && curl -sSLO "$2/$3" && curl -sSL "$2/checksums.sha256" | grep " \\*$3$" | sha256sum -c - >/dev/null && tar xzf "$3" mediamtx`,
      'sh', tmp, base, tar], { stdio: ['ignore', 'inherit', 'inherit'] });
    renameSync(join(tmp, 'mediamtx'), MTX);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return MTX;
}
