# In-browser noise suppression for hub voice rooms

Research date: 2026-10-03. Scope: free, self-hostable, runs client-side (WASM / AudioWorklet / ONNX), Firefox first, Chrome second.
Case: 5-15 Minecraft players, open mic with voice activation, mechanical keyboards, mouse clicks, fans, game audio, sometimes speakers.

Confidence tags: [V] verified from a primary source this session, [S] secondary or vendor/blog source, [U] unverified or from memory.

## 1. Short answer

- No in-browser model currently matches Krisp's "remove other voices and loud transients" behaviour. The best free approximation is a full-band neural suppressor (DeepFilterNet3) in an AudioWorklet, with the browser's echo cancellation left ON and the browser's noise suppression OFF, plus a voice-activity gate in front of the transmit path.
- DeepFilterNet3 (DFN3) has the best measured quality of anything that ships as a usable browser build. Its cost is a 15-25 MB download and a real CPU load on weak laptops. Its npm wrapper is thin and third-party.
- RNNoise (0.2 model, tiny, 48 kHz native) is the safe fallback. It is cheap and mature but weaker on non-stationary noise. Reports on mechanical keyboards are mixed.
- GTCRN (16 kHz, 48k params) is the interesting newcomer: very cheap, MIT, and sapphi-red has a WASM build. There is little evidence yet on quality for keyboard noise.
- None of these separates a second voice well (speakers bleeding into the mic, a roommate talking). That needs an echo canceller or a target-speaker model, which has no mature free browser option.

## 2. Comparison table

| Option | Rate | Quality evidence | Browser cost | Download | Licence | Port maturity | Firefox worklet |
|---|---|---|---|---|---|---|---|
| Browser built-in NS (libwebrtc APM) | 48k internal | Classic DSP, stationary noise only [U]. Does little for keyboard clicks. | ~0 (native) | 0 | n/a | n/a | Yes, same APM family [V] |
| RNNoise 0.2 (Xiph) | 48k | Author claims better than 0.1, no independent numbers [S]. Keyboard: mixed [S]. | Very low. 10 ms frames, ~10 ms algorithmic delay [S]. | ~2-5 MB npm unpacked, model is part of wasm [V sizes] | BSD-3 | `@shiguredo/rnnoise-wasm` (Apache-2.0, active 2026-07, built from xiph main), `@jitsi/rnnoise-wasm` (updated to 0.2, Dec 2024), `@timephy` (stale 2024) | Fine, plain wasm |
| sapphi-red/web-noise-suppressor | 48k (RNNoise), 16k/48k (GTCRN) | Wraps others | Low | ~0.9 MB package (unpacked) + wasm | MIT | Active, v0.4.1 2026-09-19. Open issue: RnnoiseWorkletNode memory leak with many create/destroy cycles [V] | Needs AudioWorklet only |
| DeepFilterNet3 (libDF, wasm) | 48k | PESQ-WB 3.22, STOI 0.95, DNSMOS OVRL 3.23 on VoiceBank+DEMAND, beats DTLN and DPDFNet in the same test [V, workadventure PR 15] | Measured RTF 0.013 on Apple M4 [V]. Per frame 0.33 ms mean with tract 0.23.8 on Apple Silicon [V]. Slow x86/Firefox untested there. | ~15-24 MB (wasm 10-15 MB + model ~8 MB) [V] | MIT OR Apache-2.0 | Third-party wrappers only (see 3.4). Several pitfalls. | Works in Firefox per wrapper authors, but Firefox wasm ~3x slower claimed by one demo [S] |
| DTLN (via @workadventure/noise-suppression) | 16k | PESQ-WB 2.52, DNSMOS OVRL 2.99 [V]. "Muffled/telephone" sound due to 16 kHz [V]. | RTF 0.02 on M4 [V] | ~4 MB models; package unpacked 130 MB (includes LiteRT bundles) [V] | MIT | New (2026-05), Firefox+WebKit test matrix in CI [V] | Firefox tested in CI [V]; 16 kHz context carries Firefox mic-rate risk [S] |
| GTCRN (Xiaobin-Rong) | 16k | PESQ 2.87, STOI 0.940 (VCTK-DEMAND), DNSMOS OVRL 2.70 (DNS3 blind) [V] | 33 MMAC/s, RTF 0.07 on desktop i5-12400 in native [V]. Smallest cost of the neural group. | ~262 KB unpacked wasm package [V] | MIT | `@sapphi-red/gtcrn-wasm` 0.0.3 (2026-08), brand new | AudioWorklet supported per README [V]; untested by us |
| UL-UNAS (2025, same author as GTCRN) | 16k | Paper only, not checked [U] | Ultra-lightweight [S] | n/a | MIT | No browser port found; ONNX streaming code added 2026-02 [V] | n/a |
| DPDFNet (Ceva, 2025) | 8/16/48k | Slightly better than DFN3 on three 16 kHz clips (DNSMOS 3.19 vs 3.02), worse at 48k in the full test [V] | ~7x DFN3 CPU, RTF 0.20 native [V]. Not realistic in a worklet. | 10-14 MB ONNX | Apache-2.0 | No browser port | no |
| NSNet2 (Microsoft DNS baseline) | 16k | Older (2020-21) baseline, lower than DFN3 [U]. | ONNX, usable via onnxruntime-web | ~5-10 MB [U] | Repo CC-BY-4.0, model licence not verified | No maintained worklet port found [U] | n/a |
| Speex preprocess (speexdsp) | any | Classic DSP, stationary only, poor on clicks [U] | negligible | tiny | BSD | sapphi-red wrapper [V] | fine |
| Fast-ULCNet (2026) | 16k | Paper only, not read [U] | n/a | n/a | n/a | No port | n/a |

## 3. Notes by option

### 3.1 Built-in browser noise suppression
- Both Firefox and Chrome run libwebrtc's Audio Processing Module (APM) for getUserMedia [V for Firefox: Bug 1397793, searchfox MediaEngineWebRTCAudio.cpp].
- Firefox: NS level taken from a pref, default falls back to kModerate; if the platform does its own NS through cubeb input processing, Firefox disables APM NS [V]. Processing is skipped entirely if AEC, AGC and NS are all off [V]. A high-pass filter is on whenever AEC/AGC/NS is active (Firefox 77+) [V].
- Chrome: same family, but constraints are coupled in a non-standard way (echoCancellation changes NS and AGC) [S, Mozilla blog]. Chromium bug 327472528 reports echoCancellation/noiseSuppression sometimes cannot be disabled by constraints [S, search result, not opened]. Always read back `track.getSettings()`.
- `voiceIsolation` constraint: Chrome ships it only where the OS has a matching effect (ChromeOS first); Firefox has no implementation I could confirm [S]. Do not count on it.
- What the classic APM NS handles: steady hiss, fans, hum. It is not trained on transients, so mechanical keyboard and mouse clicks mostly pass [U, widely reported; no primary measurement found]. This is the main reason to go neural.

### 3.2 RNNoise
- v0.2 released 2024-04-15: improved training, SSE4.1/AVX2 and runtime CPU detection, models trained only on public data [V, GitHub release]. Valin says on Mumble issue 6395 that quality should improve, including for reverberant speech [S]. No independent PESQ/DNSMOS for 0.2 found. Last upstream commits: augmentation/loss tuning and VAD fading fix (Jan 2025), so the main branch model is newer than the v0.2 tag [V].
- Browser builds: Shiguredo changelog says it now builds from xiph/rnnoise main (commit 70f1d256...), SIMD temporarily removed [V]. Jitsi updated to 0.2 in Dec 2024 [V]. timephy last published Aug 2024, avoid [V].
- Frame is 10 ms at 48 kHz (480 samples), the AudioWorklet quantum is 128 samples, so a ring buffer is needed [S]. Delay about 10 ms [S].
- Keyboard noise: the only reports are blog/vendor claims, from "60-70% reduction" to "clicks eliminated" to "not guaranteed" [S]. Treat as unknown; test with our own recordings.
- Known problem: sapphi-red issue 42, memory leak on repeated create/destroy [V]. Not a problem if the node lives for the whole session.

### 3.3 DTLN and GTCRN (small 16 kHz models)
- DTLN via @workadventure/noise-suppression: MIT, LiteRT.js, 512-sample block (4 render quanta), expects a 16 kHz AudioContext [V]. Their own measurement shows it sounds band-limited (nothing above 8 kHz is sent) and scores below DFN3 [V].
- GTCRN: 48.2k params, 33 MMAC/s, MIT [V]. sapphi-red's wasm is generated with onnx2c, has STFT inside wasm, 16 ms frames at 16 kHz, optional 48 kHz host-rate resampler (768 samples per call) [V]. Output at 16 kHz model quality means upsampled narrowband audio. Fine for voice chat intelligibility, but not "Krisp-like" fullness.
- Both 16 kHz paths raise the Firefox sample-rate question in section 5.

### 3.4 DeepFilterNet3 browser ports
- Upstream: dual MIT/Apache-2.0, 48 kHz native, paper reports RTF 0.19 on one notebook CPU thread (native) [V, arXiv 2305.08227]. Upstream repo last pushed 2024-10; effectively unmaintained but stable [V].
- Browser wrappers found:
  - `deepfilternet3-noise-filter` 1.3.0 (2026-06-26, Apache-2.0 OR MIT, from mezonai/mezon-noise-suppression, 65 stars). Has `DeepFilterNet3Core` with `createAudioWorkletNode`, a 0-100 suppression slider, assets inlined or from a CDN [V]. Written for LiveKit but usable standalone. Unpacked package is small (72 KB); the wasm/model are fetched from `cdn.mezon.ai` by default [V from README]. Self-host the assets (`assetConfig.cdnUrl`) rather than depend on a third-party CDN.
  - `workadventure/noise-suppression` open PRs 15-22 build their own libDF wasm with tract 0.23.8 and wasm SIMD [V]. Not merged to main as of today; the published package 0.1.1 is DTLN only. The PR text was written with an AI assistant (it says so); numbers look careful but treat as secondary until reproduced.
- Measured quality (workadventure PR 15, 50 VoiceBank+DEMAND pairs, 48 kHz): DFN3 PESQ-WB 3.22 / DNSMOS OVRL 3.23 vs DTLN 2.52 / 2.99 vs noisy 2.07 / 2.77 [V]. Caveat: VoiceBank+DEMAND is mostly stationary-ish noise, not keyboards.
- Measured cost: RTF 0.013 on Apple M4 / Chrome. Per 10 ms frame 0.33 ms mean, 0.45 ms p95 on Apple Silicon with tract 0.23.8; 1.05 ms with older tract 0.21.4 [V]. Not measured on x86 or Firefox in these PRs [V: "Not measured on x86"]. Per 128-sample quantum the budget is 2.67 ms at 48 kHz [V].
- Latency: model 30 ms (10 ms with the DFN3_ll variant) + about 10.7 ms reframing + optional gate lookahead, about 91 ms total in WorkAdventure's chain [V]. Fine for conversation, noticeable.
- Download: wasm 10-15 MB + model ~8 MB, ~24 MB total in their fetch script, ~17 MB cached in boredland/noise [V].
- Pitfalls documented by the PR authors [V]: no `crypto` in AudioWorkletGlobalScope (needs a getRandomValues shim); a `.tar.gz` served with `Content-Encoding: gzip` gets inflated and libDF panics (serve the model so the browser does not decode it); wasm module must be compiled on the main thread and passed in; `df_create` blocks the audio thread about 200-390 ms at start; `TextEncoder` missing in worklet scope; wasm SIMD required (Firefox 89+); a worklet that cannot keep up crackles silently, so add an overload monitor and fall back.
- Useful options in the PRs: pause gate (mutes when the model output is below a floor), `minSpeechFrames` 2-3 to keep single-frame clicks out, post-gain to replace AGC, 25 dB attenuation limit option [V]. These map directly onto our keyboard problem.
- Firefox speed: boredland/noise says Firefox is about 3x slower on WASM workloads, citing Bugzilla 1539865 and onnxruntime 10134 [S]. I opened 1539865: it is a 2019 JetStream tiering bug, resolved in Firefox 68, so it does NOT support the 3x claim today [V]. The 3x figure is unverified for modern Firefox. Measure it.

### 3.5 Other
- DPDFNet (Ceva, Apache-2.0, 2025-26, active): quality close to DFN3, 2.5-3.6M params, 2.4-7.2 GMAC, RTF 0.20 native on one core. Too heavy for a worklet [V].
- UL-UNAS (MIT, Xiaobin-Rong, 2025; ONNX streaming code added Feb 2026) and Fast-ULCNet (arXiv 2601.14925, 2026): promising small models; no browser port, no keyboard-specific evidence [V existence, U quality].
- FSPEN, NSNet2, DNS-Challenge winners: no maintained browser port found. NSNet2 weights sit in the Microsoft DNS-Challenge repo (CC-BY-4.0 for the repo); check the model licence before use [U].

## 4. Combining with echo cancellation

- Order: browser AEC (inside getUserMedia) -> your AudioWorklet NS -> RTCPeerConnection. This is the natural order and what the WorkAdventure README does: `echoCancellation: true, noiseSuppression: false` on getUserMedia, then the worklet [V]. Never run the neural model before AEC: it would remove the speech-like residue the AEC needs, and it has no playback reference.
- Turn the browser NS off when using a neural model so two suppressors do not stack (pumping, musical noise). A voice-chat project issue says the same [S].
- AGC: the browser AGC runs before your denoiser and can raise room noise when the speaker is quiet [V, workadventure PR 17]. Either turn AGC off and use a post-denoiser gain, or accept it.
- Double processing: if NS is on at both stages the second one acts on already-processed audio and tends to clip word onsets. Prefer one stage.
- AEC reference caveat [U]: the browser AEC only cancels audio it knows it played. Route remote audio through ordinary `<audio>`/RTCPeerConnection playback; routing it through a Web Audio graph can reduce AEC effectiveness in some browsers. Test on speakers in Firefox and Chrome.
- Firefox AEC quirk: Firefox bug 1627313 (echo from remote peers) was fixed with a high-pass filter in Firefox 77 [V], and Firefox sets a drift-compensation mode in some cases that can suppress non-echo signal [V from search summary of MediaEngineWebRTCAudio.cpp].
- For speakers with open mic, AEC quality matters more than NS quality; a neural suppressor will not rescue a poor echo path.

## 5. Firefox-specific risks (verify early)

1. Sample-rate mismatch: `createMediaStreamSource` throws NotSupportedError in Firefox if the AudioContext rate differs from the mic stream rate [S, MDN compat issue 16213, Mozilla Bug 1388586 comment; a report about Firefox 140 ESR]. Chrome and Safari resample. DFN3 and RNNoise want 48 kHz, which is the usual mic rate, so create the context with `sampleRate: 48000` after checking `track.getSettings().sampleRate`, or create it with no rate and resample yourself. 16 kHz models (DTLN, GTCRN) hit this hardest. WorkAdventure's CI includes a Firefox matrix with 16 kHz, so it is likely workable but check [V that CI exists, U that it passes].
2. WASM speed on the audio thread in Firefox: unmeasured for DFN3. Plan an overload detector and automatic fallback to RNNoise or the browser NS.
3. `performance.now()` is absent in AudioWorkletGlobalScope in Chromium and WebKit, so load must be estimated with `Date.now()` [V].
4. Allocating wasm memory repeatedly can run out (sapphi-red issue 42) [V]. Create the worklet once per session.

## 6. Recommendation for the hub

1. Default pipeline: `getUserMedia({echoCancellation:true, noiseSuppression:false, autoGainControl:false/true by test, channelCount:1})` at 48 kHz -> DFN3 worklet -> gate (client-side VAD, hold time ~200-300 ms, `minSpeechFrames` 2-3) -> RTCPeerConnection.
2. Ship RNNoise (`@shiguredo/rnnoise-wasm` or `@sapphi-red/web-noise-suppressor` RnnoiseWorkletNode) as the low-CPU fallback and as the automatic fallback on overload.
3. Keep the browser's own `noiseSuppression: true` as the last fallback.
4. Self-host the wasm and model files from the Go server; lazy-load (about 24 MB), cache with a service worker or HTTP cache headers, and serve the model file without content-encoding gzip.
5. Before committing, run a bake-off on 5-10 recordings of our own: mechanical keyboard, mouse clicks, fan, game audio, and speakers. Candidates: browser NS, RNNoise 0.2, GTCRN, DFN3 (and DFN3_ll). Measure CPU in Firefox on a mid-range Windows laptop and on Linux.

## 7. Biggest uncertainties

- Real Firefox performance of the DFN3 wasm on x86 (no published numbers; 3x claim is unverified).
- Keyboard/transient performance of every model: all benchmarks use VoiceBank+DEMAND or DNS-style sets, not mechanical keyboards. Our own A/B is the only real evidence.
- Whether the third-party DFN3 wrappers will be maintained (small repos, Claude-assisted PRs, upstream DFN idle since late 2024).

## 8. Sources

- RNNoise repo: https://github.com/xiph/rnnoise ; v0.2 release: https://github.com/xiph/rnnoise/releases/tag/v0.2 ; Mumble issue with Valin's comment: https://github.com/mumble-voip/mumble/issues/6395
- Shiguredo rnnoise-wasm: https://github.com/shiguredo/rnnoise-wasm (CHANGES.md, build-rnnoise.sh) ; Jitsi: https://github.com/jitsi/rnnoise-wasm ; timephy: https://github.com/timephy/rnnoise-wasm
- sapphi-red/web-noise-suppressor: https://github.com/sapphi-red/web-noise-suppressor (issue 42: https://github.com/sapphi-red/web-noise-suppressor/issues/42) ; gtcrn-wasm: https://github.com/sapphi-red/gtcrn-wasm
- GTCRN: https://github.com/Xiaobin-Rong/gtcrn ; UL-UNAS: https://github.com/Xiaobin-Rong/ul-unas ; Fast-ULCNet: https://github.com/narrietal/Fast-ULCNet (arXiv 2601.14925)
- DeepFilterNet: https://github.com/Rikorose/DeepFilterNet ; paper https://arxiv.org/abs/2305.08227
- DFN3 wasm wrapper: https://www.npmjs.com/package/deepfilternet3-noise-filter ; https://github.com/mezonai/mezon-noise-suppression ; demo https://github.com/boredland/noise
- WorkAdventure: https://github.com/workadventure/noise-suppression (PR 15 https://github.com/workadventure/noise-suppression/pull/15 , PR 17 .../pull/17 , PR 19 .../pull/19 , PR 21 .../pull/21)
- DPDFNet: https://github.com/ceva-ip/DPDFNet
- DTLN: https://github.com/breizhn/DTLN
- Microsoft DNS Challenge (NSNet2 baseline): https://github.com/microsoft/DNS-Challenge
- Firefox: https://bugzilla.mozilla.org/show_bug.cgi?id=1397793 , https://searchfox.org/mozilla-central/source/dom/media/webrtc/MediaEngineWebRTCAudio.cpp , https://bugzilla.mozilla.org/show_bug.cgi?id=1627313 , https://bugzilla.mozilla.org/show_bug.cgi?id=987186 , https://bugzilla.mozilla.org/show_bug.cgi?id=1539865 , https://bugzilla.mozilla.org/show_bug.cgi?id=1388586 , https://github.com/mdn/browser-compat-data/issues/16213
- Chrome/voiceIsolation: https://groups.google.com/a/chromium.org/g/blink-dev/c/hPMvCu-3iPA , https://issues.chromium.org/issues/327472528 , https://w3c.github.io/mediacapture-extensions/
- Secondary/vendor (low weight): https://www.forasoft.com/learn/ai-for-video-engineering/articles-ai/real-time-noise-suppression-krisp-rnnoise-deepfilternet , https://noisereducerai.com/blogs/deepfilternet-vs-rnnoise/ , https://krisp.ai/blog/best-noise-cancelling-app/ , https://github.com/nickolaiposs/friendspeak/issues/21
