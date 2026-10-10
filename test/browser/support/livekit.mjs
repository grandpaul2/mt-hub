// Fetches the LiveKit server the voice and stream suites run, once, into fetched/ (not in git),
// with its checksum checked. run.mjs calls this before starting the suites, so two suites never
// download it at the same time; each suite calls it too, which does nothing when it is there.
// The download goes into a private folder first and is moved into place, so a half-finished
// download is never taken for the binary. Linux x86-64 only (the tarball name below).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..', '..');
export const LK = join(root, 'fetched', 'livekit-server');
const LK_VERSION = '1.13.7';

export function ensureLivekit() {
  if (existsSync(LK)) return LK;
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(`the voice and stream suites need Linux x86-64 to run LiveKit ${LK_VERSION} (this is ${process.platform} ${process.arch}); skip them: node test/browser/run.mjs <the other suites>`);
  }
  const fetched = join(root, 'fetched');
  mkdirSync(fetched, { recursive: true });
  const tmp = mkdtempSync(join(fetched, 'livekit-tmp-'));
  try {
    const base = `https://github.com/livekit/livekit/releases/download/v${LK_VERSION}`;
    const tar = `livekit_${LK_VERSION}_linux_amd64.tar.gz`;
    execFileSync('sh', ['-ec', `cd "$1" && curl -sSLO "$2/$3" && curl -sSL "$2/checksums.txt" | grep "  $3$" | sha256sum -c - >/dev/null && tar xzf "$3" livekit-server`,
      'sh', tmp, base, tar], { stdio: ['ignore', 'inherit', 'inherit'] });
    renameSync(join(tmp, 'livekit-server'), LK);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return LK;
}
