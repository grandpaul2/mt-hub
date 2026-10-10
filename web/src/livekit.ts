// LiveKit's client, built as its own file (livekit.js) that voice.ts loads when someone first
// joins a voice chat, so the page doesn't download it before then. It hands itself over as
// window.livekit.
import * as livekit from 'livekit-client';

(window as unknown as { livekit: typeof livekit }).livekit = livekit;
