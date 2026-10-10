# Voice rooms: what real open-source products ship, and how it goes for users

Researched 2026-10-03. Web only. Primary sources (repos, issues, PRs, code read via `gh api`) are marked **[P]**.
Secondary or anecdotal sources (blogs, vendor pages, search summaries) are marked **[S]**. Anything I could not confirm is marked **UNVERIFIED**.

## 1. Summary of lessons

1. **Nobody ships a pure-JS stack that beats the browser on its own. The common pattern is: browser AEC stays on, browser NS/AGC on by default, plus an optional neural NS in an AudioWorklet (RNNoise most often).** Jitsi, Stoat, Nextcloud Talk and Fluxer all do this. Element Call and Galene ship browser constraints only.
2. **Missing VAD/volume gate plus noise suppression is the top reason friend groups reject open-source Discord replacements.** Element Call #2295 and #562, Stoat #1011 and #277, Nextcloud #1592, and Fluxer #1054 all say so, often in "we went back to Discord" terms. Open mic without a gate and without good NS is what people complain about.
3. **Neural NS makes the voice worse in specific, repeatable ways: words cut off, robotic/choppy audio, low volume, and "sizzling".** The Jitsi, Fluxer and Discord-Krisp reports all show it. The causes found so far are in section 4.
4. **A ship-quality feature needs a fallback and a kill switch.** Fluxer's design is the best example: a backend-availability registry with exponential backoff, a fallback to browser NS, level-collapse detection, and a per-device profile. Mumble keeps RNNoise as an opt-in choice, not the default.
5. **Screen/stream audio and "studio" use must bypass voice processing.** Element Call, Stoat #1366 and Fluxer's "studio" mode all show this.
6. **Browser AGC can fight the OS mic level** (Stoat #563). Offer an AGC toggle.
7. **Firefox is a real constraint, not a footnote**: AudioContext sample-rate mismatches, the stereo-capture check in Jitsi, and Firefox-specific AEC issues in Element Call. Details in section 5.
8. **A reusable component exists**: `@sapphi-red/web-noise-suppressor` (section 7). Fluxer and Nextcloud Talk both ship it, and it is the smallest path from "nothing" to a working Firefox-capable NS.

## 2. Per-product findings

### 2.1 Jitsi Meet (the most-used OSS browser voice product)

- **What it ships [P]:** Browser getUserMedia constraints (AEC/NS/AGC) are always on. On top there is an optional "Extra noise suppression" toggle that routes the mic track through RNNoise (WASM) in an AudioWorklet. Maintainer saghul, issue #14719: "Noise suppression is always enabled. The dedicated setting adds some extra suppression." Config switches: `disableAEC`, `disableAGC`, `disableNS`, `disableAP` in `config.js`.
- **Worklet design [P]:** The worklet runs 128-sample blocks. RNNoise needs 480 samples, so a circular buffer bridges them. The wasm is `jitsi/rnnoise-wasm` (Apache-2.0, last pushed 2025-02). Audio runs through `createMediaStreamSource` into `createMediaStreamDestination`.
- **RNNoise is also used as a VAD [P]:** The older RNNoise 0.1 build gives voice-activity scores for the "talk while muted" and "noisy mic" features. `rnnoise-wasm`'s README says it keeps both versions for this reason.
- **Krisp [P]:** Optional in `config.js` (`noiseSuppression.krisp.enabled`). Jitsi does not bundle it. You supply the Krisp JS SDK files yourself (tested with v2.0.0). RNNoise is the default. I found nothing confirming Krisp availability in JaaS (UNVERIFIED).
- **Default [P]:** Extra NS is off by default. Issue #14719 asked for it on by default, and the answer was a per-browser setting plus an iframe command.
- **Complaints [P]:**
  - #14125 "Robotic voice, Windows 11, Chrome 119": voice goes robotic when the tab is backgrounded and NS is on. Fine with NS off. Maintainer's diagnosis in #15183: Windows/Chrome "efficiency mode" throttles the tab, so the worklet misses its deadlines. Workaround is `--disable-features=UseEcoQoSForBackgroundProcess`.
  - #15183 "Sizzling sound, sometimes breaks incoming audio" (Windows only, same cause).
  - #14888 "Failed to start noise suppression" on Firefox: "Stereo audio noise suppression is not currently supported." The RNNoise path needs a mono capture. A different Firefox 127 regression in the same thread broke audio entirely, unrelated to NS.
  - #17726 RNNoise output arrives in one channel only.
  - #12092 the speaking indicator lights up while muted with NS on.
  - #17819 "10-15% CPU while alone and muted": a maintainer attributes it to the talk-while-muted feature still analysing mic data.
  - #14632/#14319 mobile apps do not get the extra NS (web only).
- **Takeaways:** (a) Jitsi treats neural NS as an add-on, not the base layer. (b) Tab throttling is a real failure mode for worklet DSP. (c) Keep analysis (VAD) cheap when muted.

### 2.2 Element Call / Matrix (LiveKit-based)

- **What it ships [P]:** The browser's NS and AEC only. `UrlParams.ts` has `noiseSuppression` and `echoCancellation` flags defaulting to true. Screen share capture explicitly sets AGC, NS and voiceIsolation off, and leaves echoCancellation unset because setting it false makes the screenshare track contain an echo of incoming voices (code comment in `LocalMember.ts`).
- **No neural NS, no VAD, no gate [P]:** #714 (noise reduction), #3069 and #1638 (RNNoise requests, closed as duplicates of #714), #562 (VAD threshold slider), #2295 (volume gate), #265 (a user wants to disable NS, citing NoiseTorch). All open.
- **User sentiment [P], #2295:** "Having open mics is not a great experience", "The lack of this really makes longer calls pretty much unusable" (2026-08-30). A gaming group says it will not move from Discord until a gate exists.
- **AEC bugs [P]:** #1437 "No AEC on Firefox?": echo started exactly when the user opened the settings dialog. Cause: the app requested a second mic stream to enumerate devices, which disturbed the AEC. Fix: stop requesting a stream at startup. #3651 echo at 20-25% packet loss.
- **Takeaway:** a calling product with browser-only processing and no gate is "not usable for gaming groups", per its own users. Also a warning about opening extra getUserMedia streams.

### 2.3 LiveKit client SDK (what Element Call, Stoat, and Fluxer run on)

- **Defaults [P]:** `audioCaptureDefaults` = autoGainControl, echoCancellation, noiseSuppression, voiceIsolation all `true` (`src/room/defaults.ts`). DTX is on by default for mono tracks.
- **Maintainer position [P]:** issue #1881: "The client sdk uses the browser's built in noise suppression by default"; stronger NS is Krisp, only on LiveKit Cloud. The `@livekit/krisp-noise-filter` package and `useKrispNoiseFilter` hook are cloud-only. Not usable for self-hosted free/OSS.
- **Processor API [P]:** `track.setProcessor()` with the `TrackProcessor` interface. `@livekit/track-processors` ships only a gain processor as an audio reference. Third parties (Stoat, Fluxer, mezon) fill the gap.
- **Pitfall [P]:** #1541 capture options are applied only on the first mic enable; re-enabling later reuses the acquired track. Changing settings needs a track restart.

### 2.4 Mumble (desktop; the VAD reference)

- **Defaults [P, `Settings.h`]:** transmit mode = VAD, VAD source = Amplitude (SNR is the other option), `fVADmin 0.80`, `fVADmax 0.98`, voice hold 20 frames (0.2 s), noise cancel = Speex at -30 dB. Echo cancellation off by default.
- **VAD logic [P, `AudioInput.cpp`]:** two thresholds with hysteresis: open above `fVADmax`; stay open while level is above `fVADmin` or within the hold time. That is the classic open-mic gate.
- **RNNoise history [P]:**
  - 1.5 RC2 (#6292) excluded and discouraged RNNoise: the bundled 0.1 library duplicated Opus/CELT symbols, causing crashes on macOS. Maintainers also called it unmaintained.
  - Davide Beatrici objected: "the technology itself proved to be useful in suppressing background noises such as clicky keyboard switches."
  - 1.5 RC3 (#6364) restored it as "ReNameNoise", a symbol-renamed fork, as a hotfix.
  - RNNoise's author (jmvalin) posted in #6395 that v0.2 improves quality including reverberant speech, uses models trained on public data, and no longer clashes with Opus symbols. Mumble has not adopted it as of the issue state I saw.
  - Both noise-cancel modes (Speex, RNNoise, or both) exist in the code (`noiseCancelMode`).
- **Future plans [P]:** #6299 (DeepFilterNet) and #7366 (Silero VAD) are open. A maintainer (Hartmnt) said Silero VAD "does not seem to be an issue... when noise reduction is configured properly". Another (Krzmbrzl) said the current VAD code "prints to stdout that it is based on a hack and is pending a complete rewrite" and that he sometimes struggles to configure it so it starts only when he wants. The long-term plan is a plugin system via libcrossaudio.
- **Web client [P]:** The only maintained-ish one is `Johni0702/mumble-web` (last push 2023-05, 738 stars). Its voice code uses the `voice-activity-detection` npm package (a simple energy VAD) with a user-set `vadLevel` and a ~125 ms start delay compensated by a backlog buffer. It calls `getUserMedia({audio:true})` with default constraints. No neural NS.
- **Takeaway:** The two-threshold plus hold-time gate is proven and easy. A VAD start delay needs a pre-roll buffer, or first syllables get clipped.

### 2.5 Stoat (formerly Revolt) web/desktop

- **History [P]:** Voice was LiveKit-based from early 2026. Discussion #277 (Oct 2022 to Mar 2026) is a long request thread for "proper mic activation settings, RNNoise, amplitude detection, echo removal". User quotes: "We tried Revolt few times... every time we switch to Discord cause background noise" (2024-09); "Neural noise suppression, echo removal its the MAIN feature" (same user).
- **Developer statement [P], Zomatree 2026-02-10:** "We are currently evaluating using rnnoise, it's basically the only viable model... easily implementable for us. Krisp... denied our application." WebRTC's default NS is "not the best out there".
- **What shipped [P, `for-web`]:**
  - PR #783 (merged 2026-03-12) added a toggle "Enhanced noise suppression" using RNNoise via the author's npm package `livekit-rnnoise-processor` (Apache-2.0, v3.0.2 2026-07-22, ~2 MB worklet+model downloaded only when enabled; resamples to 48 kHz inside the worklet).
  - `VoiceProcessor.ts` chain when enhanced: high-pass 50 Hz, RNNoise, `DynamicsCompressor` (threshold -3 dB, ratio 20, attack 3 ms, release 50 ms, i.e. a limiter), gain. States: `disabled | browser | enhanced`.
  - Later change #1512 made `enhanced` the default ("rnnoise is working great", no UI change). Defaults: echoCancellation true, autoGainControl true.
- **Known gaps and complaints [P]:** No push-to-talk or VAD gate yet (#278, #1011, "Volume Gate / AI Hybrid Gate", where a user says it tries to cancel out each other's voices when gaming in the same room). #563 the desktop app silently lowers the OS mic level (browser/Chromium AGC), reported on Windows, Fedora, Ubuntu, Nobara and CachyOS. #1366 screen-share audio is "underwater" and ducks when you talk because it passes through voice processing. #1510: the Web Audio graph was attached to every mic track even with no processing, adding latency (closed when the default became RNNoise).
- **Takeaway:** Stoat took the simplest path (RNNoise worklet, default-on, plus a limiter). The follow-up issues are all about what surrounds it: AGC, gate, PTT, screenshare.

### 2.6 Fluxer (open-source Discord clone, AGPL-3.0, public beta; closest analogue to your goal)

All from the repo `fluxerapp/fluxer` [P], read 2026-10-03.

- **Backends (`NoiseSuppressionBackends.ts`):** `none`, `standard` (browser constraint), `gate` (worklet noise gate), `speex`, `rnnoise` (48 kHz only), `gtcrn` (16/48 kHz, needs WASM SIMD), `deep_filter` (DeepFilterNet3, ONNX+wasm). The worklets are `@sapphi-red/web-noise-suppressor` with a build-time wrapper that passes audio through until the wasm is ready and reports init failures. The desktop app also has a native Rust APM crate.
- **Profiles (`VoiceProcessingProfile.ts`):** `voice` (AEC on, content hint "speech"), `studio` (everything off, content hint "music", stereo possible), `custom`. Profile can be chosen per input-device label.
- **Resilience (`NoiseSuppressionAvailability.ts`, `DeepFilter.ts`):** each backend has a failure record with exponential backoff (30 s up to 15 min). The effective backend falls back to `standard` if the requested one is unusable (assets not loaded, sample-rate mismatch, wasm failure, graph unavailable). There is a liveness check every 250 ms and "level fault" detection (input above -50 dBFS but output collapsed, 4 reports) to catch a silently dead denoiser. Assets are prefetched on idle and the worklet is disposed after 60 s idle.
- **User complaints (issue #878 META, #1054, #807, #278) [P]:** "Enhanced noise suppression cuts out voice", "Cuts off words and makes our voices too low", "robotic and muted for all parties" (a Firefox-on-Linux user, with a Windows/Chrome listener), "low volume, clipping, robotic voices" (Windows desktop, six people), "basic noise suppression does nothing". Multiple groups "are not really using Fluxer until this is improved". One user: noise cancellation "only works in the Chrome browser". The maintainers' reply: basic (browser) NS is known broken; enhanced NS is to become the baseline; a "big voice architecture update" is coming. Many older issues were mass-closed.
- **Roadmap [S]:** the 2026 roadmap mentions DeepFilterNet3 and more mic controls in canary.
- **Takeaway:** Even with best-effort engineering (profiles, fallback, level checks) the first public release of neural NS drew "cuts out voice" bug reports from many users. Plan for tuning, a visible on/off switch, and diagnostics a user can paste.

### 2.7 Nextcloud Talk (spreed)

- **What it ships [P]:** In 2026 it moved to RNNoise via `@sapphi-red/web-noise-suppressor` (`src/utils/suppressNoise.ts`): shared AudioContext and one worklet, ref-counted consumers, `maxChannels: 2`, wasm and SIMD wasm, secure context required. After testing the Jitsi route (issue #17147), the maintainers wrote "Have better implementation results with `@sapphi-red/web-noise-suppressor`". PR #17672 reworked the UI into a radio group: Off/Basic (browser), model, and auto-gain on/off, with Safari hiding unsupported options.
- **Complaints [P]:** #17858 Safari duplicates audio tracks with the model on. The PR's Firefox test box was unchecked (so Firefox status is UNVERIFIED). Older #1592 asked for voice activation like Mumble/TeamSpeak ("that common that it is the default setting in these apps"), still open, but no gate shipped.
- **Takeaway:** an independent team compared the Jitsi worklet to sapphi-red's and picked sapphi-red.

### 2.8 Galene (jech)

- **Ships [S, official FAQ per search summary; not read directly]:** No server-side audio processing. Browser constraints with sender-side options in the side menu: a "high quality audio" mode (turns processing down for music) and a "Noise suppression" toggle. Echo advice in the FAQ: if you sound "under water", the echo canceller is overloaded, use headphones or lower speaker volume or mic gain. No neural NS, no VAD gate (UNVERIFIED beyond the FAQ).

### 2.9 Spacebar (ex-Fosscord)

- **State [S]:** Voice/video is experimental. The docs say voice is optional and not production-ready; the client is "not ready to use as a daily driver". A third-party review lists "no noise suppression or echo cancellation (yet)". I did not inspect their client code. UNVERIFIED. Not a useful reference.

### 2.10 Rocket.Chat, Zulip, Signal

- Rocket.Chat and Zulip delegate calls to Jitsi/BigBlueButton, so they inherit Jitsi's behaviour (no own audio stack; I did not read their code, UNVERIFIED).
- Signal (RingRTC): I could not confirm which NS/AEC settings it ships (UNVERIFIED). It uses the stock WebRTC audio processing module as far as I know, but I found no source. Not useful for a browser build.

### 2.11 TeamSpeak (comparison)

- **Ships [S, community/guide pages, not official docs]:** The TS5/TS6 client has "Voice Activity Detection" with modes Automatic, Volume Gate, Hybrid, plus a separate Noise Reduction and Echo Cancellation toggle. Hybrid is recommended for noisy rooms, per a community answer. A community thread notes the level meter updates only about every 200 ms, so the gate can trigger without a visible meter response. A feature request asks for a true noise gate and limiter. Claims that TS6 has "AI noise cancellation" are from a hosting-company blog (UNVERIFIED). A third-party TS3 plugin (`JUL14Ns-Audio-Mods`) adds RNNoise, a configurable VAD and a compressor, which shows what users wanted from the stock client.
- **Stoat #1011 user:** "TeamSpeak does this the best IMO" about the volume gate plus noise cancel combination. This is the benchmark users name for gaming.

### 2.12 Discord (reference)

- **Ships [S; Discord's support pages returned HTTP 403 to my fetcher, so I could not read them directly]:** Noise Suppression options: None, Krisp (the proprietary ML model, desktop and, since Oct 2023 per the Krisp FAQ summary, Chrome and Firefox desktop browsers), and Standard (a lighter option). Echo Cancellation, Automatic Gain Control and "Automatically determine input sensitivity" are separate toggles. Push-to-talk or voice activity with a sensitivity slider.
- **Complaints [S, mostly SEO/vendor blogs, anecdotal]:** Krisp fades sentence starts and ends, cuts out, sounds robotic or muffled on some voices, and double-processing with a noise gate adds artifacts. Stoat discussion user: "Krisp implementation in Discord is ass and keeps turning off."
- **Takeaway:** Even the market leader's ML NS is optional, user-switchable and criticised for word clipping. "Standard" exists because people want a gentler setting.

### 2.13 Others

- **Mezon** (`mezonai/mezon-noise-suppression`): npm `deepfilternet3-noise-filter` 1.3.0 (Apache-2.0 OR MIT, modified 2026-06-26, 65 stars). A LiveKit-targeted DeepFilterNet3 AudioWorklet, with a 0-100 suppression level. Reasonable but young, one org.
- **NoiseTorch / Equalizer APO + RNNoise VST / Voicemeeter** come up repeatedly as the workaround users apply themselves in Element Call, Stoat and Nextcloud threads. Meaning: a decent per-user fallback story is "use an OS-level filter and turn ours off". That is why a "none" option matters.

## 3. Defaults and settings, side by side

| Product | AEC | NS | Neural NS | VAD / gate | AGC |
|---|---|---|---|---|---|
| Jitsi | browser | browser, always on | RNNoise worklet, opt-in toggle; Krisp optional with own SDK files | none for send (RNNoise VAD only for muted-talk hint) | browser |
| Element Call | browser | browser | none | none (requests open) | browser |
| LiveKit SDK default | browser | browser | Krisp (Cloud only) | none | browser |
| Mumble | off by default | Speex -30 | RNNoise (opt-in, "discouraged" then restored as ReNameNoise) | Amplitude/SNR, 0.80/0.98, 200 ms hold, default mode | internal |
| Stoat | browser | `disabled/browser/enhanced`, default enhanced | RNNoise worklet + limiter | none yet | browser, default on |
| Fluxer | browser | 7 backends, per-profile, fallback to browser | RNNoise, GTCRN, DeepFilterNet3, Speex, gate | PTT/VAD details not checked | toggle |
| Nextcloud Talk | browser | Off/Basic/model | RNNoise (sapphi-red) | none | toggle |
| Galene | browser | browser toggle | none | none | browser |
| TeamSpeak | yes | Noise Reduction toggle | unconfirmed | Automatic / Volume Gate / Hybrid | n/a |
| Discord | yes | None/Standard/Krisp | Krisp | auto sensitivity or slider | toggle |

## 4. Recurring failure modes and the evidence

| Symptom | Seen in | Known cause or workaround |
|---|---|---|
| Robotic or "sizzling" voice | Jitsi #14125 #15183; Fluxer #878 | Worklet starved when the tab is throttled (Windows efficiency mode). Also possible: sample-rate resampling bugs (UNVERIFIED), CPU load. |
| Words cut off, voice too quiet | Fluxer #878 #1054; Discord/Krisp (S) | NS model over-attenuating speech starts and ends; low input level makes it worse. No confirmed root cause in Fluxer's threads. |
| Mic level silently drops in the OS | Stoat #563 (several Linux distros and Windows) | Browser AGC. Provide an AGC off option. |
| Screenshare/music sounds "underwater", ducks when you speak | Stoat #1366; Element Call (comment in code) | Screen-share audio passed through voice processing/AEC. Capture it with all processing off. |
| Echo | Element Call #1437 #3651; Galene FAQ | A second getUserMedia stream during a call disturbed Firefox AEC; heavy packet loss; no headphones. |
| NS fails on Firefox | Jitsi #14888; Fluxer (user report) | Stereo capture rejected by the NS path; AudioContext/getUserMedia sample-rate mismatch (see section 5). |
| Constant CPU while muted/alone | Jitsi #17819 | Analysis kept running while muted. |
| One-channel output | Jitsi #17726 | Mono worklet output to a stereo path. Force mono. |
| Keyboard leaking | Mumble maintainers, Element Call #2295 | Amplitude VAD opens on keyboard clicks; Mumble's RNNoise was kept "for clicky keyboard switches". |
| Latency from the Web Audio graph | Stoat #1510 | MediaStreamAudioDestinationNode path adds buffering in Chromium. Only attach the graph when needed. |

## 5. Firefox specifics (what the evidence supports)

- Firefox throws `NotSupportedError` from `createMediaStreamSource` when the AudioContext sample rate differs from the stream's rate. Chromium resamples instead. Create the `AudioContext` with default (device) rate, read its `sampleRate`, and resample inside the worklet. Stoat's worklet resamples to 48 kHz internally; Fluxer's availability code checks `inputContextRate` against each backend's supported rates and falls back to the browser NS. [S: Bugzilla 1387454, WebAudio #2322; P: Fluxer/Stoat code]
- Jitsi's RNNoise path refuses stereo capture (error seen on Firefox, #14888). Request `channelCount: 1` for the NS path. [P]
- Element Call saw missing AEC on Firefox only when an extra capture stream was opened. [P #1437]
- Firefox `privacy.resistFingerprinting` can trigger the same sample-rate error [S, one report]. Worth a visible "NS unavailable, using browser NS" message.
- Nextcloud's PR left Firefox untested (checkbox empty). Fluxer's report from a Firefox/Linux user ("robotic and muted for all parties, switching input caused Firefox to l...", truncated) shows real-world trouble. Both are signals, not proof.
- `voiceIsolation` constraint is a Chromium/Safari thing; LiveKit sets it but do not rely on it in Firefox. [P for LiveKit defaults; browser support UNVERIFIED]

## 6. Changes of approach over time, and why

- **Mumble:** Speex NS -> RNNoise 0.1 (added) -> removed (symbol clashes, crash on macOS, "unmaintained") -> restored as a renamed fork "by popular demand" -> future: plugin-based audio (DeepFilterNet, Silero VAD proposed). The pattern: users want ML NS badly, and maintainers' main worries are build/licensing/maintenance, not quality.
- **Jitsi:** RNNoise first for VAD hints, then moved denoising from the main thread to an AudioWorklet (latency and glitches), added Krisp as a bring-your-own-SDK option.
- **Stoat:** "evaluating RNNoise" (Feb 2026) -> opt-in toggle (Mar 2026) -> default (after a few months) because it "is working great". Counter-evidence is in Fluxer's threads, which use similar models.
- **Fluxer:** one backend -> seven with fallbacks, profiles and liveness checks, as bug reports piled up.
- **Nextcloud Talk:** Jitsi's package considered -> chose `@sapphi-red/web-noise-suppressor`.
- **Element Call:** has stayed browser-only for years despite repeated, popular requests.

## 7. Reusable components

| Component | What | License | Status (checked 2026-10-03) | Notes |
|---|---|---|---|---|
| `@sapphi-red/web-noise-suppressor` 0.4.1 | AudioWorklet nodes: NoiseGate, RNNoise, SpeexDSP preprocess, GTCRN | MIT | Pushed 2026-09-19, 93 stars; used by Fluxer and Nextcloud Talk | Open issue: `RnnoiseWorkletNode` memory leak despite `.destroy` (#42). Needs AudioWorklet and a secure context. Best first choice. RNNoise = 48 kHz only. |
| `@shiguredo/rnnoise-wasm` | RNNoise wasm build used by the above | Apache-2.0 (RNNoise BSD-3) | pushed 2026-07-14 | Upstream RNNoise is v0.2 (2024-04), models trained on public data. |
| `jitsi/rnnoise-wasm` | RNNoise wasm; has the sync build for worklets | Apache-2.0 | last push 2025-02 | Less active; sapphi-red is a better wrapper. |
| `@ricky0123/vad-web` | Silero VAD in browser via ONNX Runtime Web | ISC | pushed 2026-09-12, 2062 stars | Open issues about Firefox (#141 extension, #92 picking up speaker audio in Firefox). ONNX runtime is a heavy dependency. Needs testing on Firefox. Gives speech probabilities and start/end events, not an audio-gating worklet by itself. |
| `sapphi-red/gtcrn-wasm` | GTCRN speech enhancement, small | MIT (code and weights) | pushed 2026-08 | Needs WASM SIMD. Newer than RNNoise; quality evidence is limited (mine: none). |
| `deepfilternet3-noise-filter` 1.3.0 (mezon) | DeepFilterNet3 worklet with level control | Apache-2.0 OR MIT | published 2026-06-26, 65 stars | Heavier than RNNoise. Fluxer ships a DeepFilterNet3 build with a `deepFilterProcessor.worklet.js`. Quality/CPU on Firefox not verified. |
| `livekit-rnnoise-processor` (Dadadah) | RNNoise as a LiveKit `TrackProcessor` | Apache-2.0 | v3.0.2, 2026-07-22, 0 stars | Single-author; useful as a pattern. |
| Fluxer `noise_suppression/` code | Backend registry, availability/fallback, level-fault detection | AGPL-3.0 | active | Copying code carries AGPL obligations. Use it as a design reference unless your site is AGPL too. |
| Mumble `AudioInput.cpp` VAD | Two-threshold plus hold gate | BSD-style, per repo "NOASSERTION" (UNVERIFIED) | active | Use as the reference algorithm and re-implement (it is a few lines). |
| `Johni0702/mumble-web` | Browser Mumble client | MIT? (UNVERIFIED) | last push 2023-05 | Only as a reference for a gate with pre-roll. |
| Krisp (JS SDK / LiveKit krisp-noise-filter) | Proprietary ML NS | Proprietary | n/a | Not OSS; LiveKit's variant is LiveKit Cloud only; Stoat was refused. Out of scope. |

## 8. What I would take from all this (for the design, not a decision)

1. Layer: browser AEC always on; NS choices `Off | Browser | Enhanced(RNNoise)`; AGC toggle; a separate gate/VAD stage you own.
2. Run the gate after NS. Mumble's two-threshold plus hold, plus a pre-roll of about 100-150 ms, avoids clipped first syllables.
3. Build the fallback from day one (Fluxer-style): if the worklet fails to load, the rate is unsupported, or output goes silent while input is loud, drop to Browser NS and say so in the UI.
4. Test on Firefox first: sample-rate mismatch, mono capture, throttled background tab, and no extra getUserMedia streams during a call.
5. Screen/stream audio: processing off.
6. Ship an "I use NoiseTorch/RNNoise myself" mode (all processing off) since users already do this.
7. Keep a paste-able diagnostics block (browser, sample rate, backend, level meters): Fluxer's #878 shows how costly it is without one.
8. Treat the neural model choice as swappable (RNNoise first; GTCRN/DeepFilterNet3 later) since projects keep changing it.

## 9. Unverified or gaps

- Discord's official support pages and engineering posts: not readable (HTTP 403); statements about Standard/Krisp are from secondary sources.
- Galene FAQ, TeamSpeak docs: only via search summaries, not read directly.
- Signal/RingRTC, Rocket.Chat, Zulip audio settings: not found.
- Spacebar client code: not inspected.
- Krisp in JaaS: no source found.
- Firefox behaviour of every component above: no hands-on testing was done; issues are the only evidence.
- CPU cost numbers: none found. No product publishes CPU figures for its NS; only anecdotes (Jitsi #17819).
- Mumble's current RNNoise status after v0.2 (PR #6607 by a contributor was in progress): not confirmed.

## Sources

Repos and issues (GitHub, read with `gh api` unless noted):
- Jitsi: https://github.com/jitsi/jitsi-meet (issues 14888, 15183, 14125, 14719, 17726, 17819, 12092, 14632; config.js; PR 11547), https://github.com/jitsi/rnnoise-wasm, https://jitsi.org/blog/enhanced-noise-suppression-in-jitsi-meet/ (fetched)
- Element Call: https://github.com/element-hq/element-call (issues 714, 265, 562, 1437, 1638, 2295, 3069, 3651; `src/UrlParams.ts`, `src/state/CallViewModel/localMember/LocalMember.ts`)
- LiveKit: https://github.com/livekit/client-sdk-js (issues 1541, 1881; `src/room/defaults.ts`, `src/room/track/options.ts`), https://github.com/livekit/track-processors-js, https://github.com/livekit/components-js (`useKrispNoiseFilter.ts`)
- Mumble: https://github.com/mumble-voip/mumble (PRs/issues 6292, 6364, 6395, 6299, 7366, 6607; `src/mumble/AudioInput.cpp`, `Settings.h`, `Settings.cpp`), release notes https://www.mumble.info/blog/mumble-1.5.613-rc-2/ and https://www.mumble.info/blog/mumble-1.5.629-rc-3/ (via search summary), https://github.com/Johni0702/mumble-web (`app/voice.js`)
- Stoat: https://github.com/stoatchat/for-web (PR 783, issues 563, 1011, 1366, 1510, 1512; `packages/client/components/rtc/VoiceProcessor.ts`, `state/stores/Voice.ts`, CHANGELOG.md), https://github.com/stoatchat/discussions (discussion 277, 278), https://github.com/Dadadah/livekit-rnnoise-processor (npm `livekit-rnnoise-processor` 3.0.2)
- Fluxer: https://github.com/fluxerapp/fluxer (issues 878, 1054, 807, 278; `fluxer_app/src/features/voice/utils/noise_suppression/*`, `VoiceProcessingProfile.ts`; NOTICE.md); roadmap via https://wpnews.pro/news/roadmap-2026-fluxer (secondary)
- Nextcloud Talk: https://github.com/nextcloud/spreed (issues 17147, 1592, 17858; PR 17672; `src/utils/suppressNoise.ts`)
- Components: https://github.com/sapphi-red/web-noise-suppressor, https://github.com/shiguredo/rnnoise-wasm, https://github.com/sapphi-red/gtcrn-wasm, https://github.com/xiph/rnnoise, https://github.com/ricky0123/vad, https://github.com/mezonai/mezon-noise-suppression (npm `deepfilternet3-noise-filter`), https://github.com/Rikorose/DeepFilterNet, https://github.com/werman/noise-suppression-for-voice
- Firefox/WebAudio: https://bugzilla.mozilla.org/show_bug.cgi?id=1387454, https://github.com/WebAudio/web-audio-api/issues/2322, https://github.com/mdn/browser-compat-data/issues/16213 (all via search summary, secondary)
- Galene FAQ: https://galene.org/faq.html (via search summary)
- TeamSpeak: https://community.teamspeak.com/t/voice-detection-bug/34781, https://community.teamspeak.com/t/feature-request-noise-gate-in-microphone-settings/26135, https://github.com/Gamer92000/JUL14Ns-Audio-Mods (via search summary)
- Discord (secondary): https://support.discord.com/hc/en-us/articles/360040843952-Krisp-FAQ (403 to fetcher; search summary only), https://note.com/vanideshi/n/nd57a5e4dd25d, https://simpleclean.app/blog/discord-noise-suppression-not-working
- Spacebar: https://docs.spacebar.chat/faq/ (via search summary)
