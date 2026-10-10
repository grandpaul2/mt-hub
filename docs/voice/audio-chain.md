# Voice rooms: the audio chain apart from the denoise model

Researched 2026-10-03. Scope: VAD gate, echo cancellation and gain, Opus over WebRTC.
Tags: [V] = read in a primary source this session. [S] = search snippet only. [U] = unverified, from memory, or inferred. Test every [U] item before relying on it.

## Recommended chain (in order)

1. `getUserMedia({audio:{echoCancellation:true, autoGainControl:false, noiseSuppression:false, channelCount:1, sampleRate:48000}})`.
   Keep the browser AEC. Turn browser NS off, because the WASM denoiser replaces it. Turn browser AGC off for now (see section 2).
2. A WASM denoiser (the other agent's topic) inside an AudioWorklet, running at 48 kHz mono.
3. A VAD gate, driven by Silero VAD v5 (or v6) on a 16 kHz tap of the denoised signal. It controls a GainNode, not the track's `enabled` flag.
   - The audio path carries a lookahead delay of about 150-250 ms (a DelayNode or a ring buffer in the worklet). Because of it, the gate opens before the delayed audio reaches the output. This avoids clipped word starts.
4. A MediaStreamDestination feeds the RTCPeerConnection sender. Opus is mono, about 32 kbps, with in-band FEC on, DTX on and ptime 20 ms.
5. Playback of other people's audio goes through `<audio>` elements playing the remote WebRTC tracks. Never go through Web Audio on Chrome.

## 1. Voice activity detection

### Options compared

| Option | Notes |
|---|---|
| Silero VAD v5/v6 (ONNX) | MIT licence [V]. About 2 MB model [V]. Under 1 ms per 30+ ms chunk on one CPU thread [V]. v5 and v6 use 512-sample frames at 16 kHz, which is 32 ms [V]. Best at telling speech from non-speech. |
| `@ricky0123/vad-web` | Wraps Silero with onnxruntime-web. v5 is opt-in with `model:"v5"` and the default is still "legacy" [V]. Its docs say thresholds tuned on legacy need retuning for v5 [V]. Its licence is MIT [U, not shown in the fetched pages; check the repo]. |
| RNNoise per-frame VAD probability | A by-product output, 0 to 1 per 10 ms frame (480 samples at 48 kHz). Each integration picks its own cutoff [S]. werman's plugin suggests 85-95% on its percentage scale [S]. Free if RNNoise is already your denoiser; otherwise there is no point running it just for the gate. BSD licence [U]. |
| WebRTC VAD (libwebrtc, GMM) | Old, coarse, with 4 aggressiveness modes [U]. Not recommended for a noisy gaming room; it reacts to clicks and game audio. |
| Plain energy gate | The weakest. It triggers on keyboard clicks and game audio. Fine only as a pre-filter. |

Discord's "automatic sensitivity": no primary source describes how it works [V: searches found nothing]. Discord's help page says only that it adjusts to the input level automatically. The likely design is an adaptive noise floor plus a VAD [U]. Do not copy it; use Silero with a manual sensitivity slider that maps to the thresholds.

### vad-web defaults, and what to change [V for defaults]

| Option | Default | For a live gate |
|---|---|---|
| positiveSpeechThreshold | 0.3 | 0.5 to 0.6 for a keyboard-heavy room; expose it as a slider |
| negativeSpeechThreshold | 0.25 | the positive threshold minus 0.15 |
| redemptionMs (hangover) | 1400 | 250-400 ms for a gate (1400 is for dictation segments) |
| preSpeechPadMs | 800 | not applicable if the gate delays the audio itself |
| minSpeechMs | 400 | not used; require 2-3 consecutive frames above the threshold instead (64-96 ms) |

Important: vad-web is segment-oriented. It emits `onSpeechStart` and `onSpeechEnd` with a Float32Array. A live gate needs the per-frame probability instead. I believe it has an `onFrameProcessed(probs)` callback [U; check the API page https://docs.vad.ricky0123.com/user-guide/api/]. The safer route is to run the Silero ONNX model yourself via onnxruntime-web in a worker, or use vad-web's lower-level `NonRealTimeVAD` and `FrameProcessor` classes [U]. The library's `MicVAD` also opens its own microphone stream by default [U]. Pass it your own stream or tap.

### Gate design

- Attack: gain ramp of 5-10 ms.
- Hangover: 250-400 ms, so trailing syllables survive and short breaths don't chop speech into pieces.
- Release: gain ramp of 50-100 ms.
- Lookahead: 32 ms of VAD frame latency plus 2-3 confirmation frames means the decision lags the audio by about 100-130 ms. A delay line of 150-250 ms on the audio path means nothing is clipped. The cost is added mouth-to-ear latency of that amount. Make it a constant, and measure it. The WebRTC path adds roughly 50-100 ms more.
- Keyboard clicks: RNNoise-style suppressors reduce clicks in speech gaps but only attenuate them during speech [S]. The gate removes the gaps entirely, but clicks inside speech still leak. A confirmation-frame requirement and a higher open threshold handle most false opens. Keep a manual "Mic sensitivity" slider and a test meter.
- Run VAD on the denoised signal (after step 2), because that removes the game bleed and keyboard noise the gate would otherwise trigger on. Alternative to test: run VAD on the pre-denoise signal for onset speed. Evaluate both with real recordings [U].
- Muting with `track.enabled = false` is not free: it sends silence frames. Prefer a GainNode to 0 plus DTX so the sender stops transmitting. DTX only sends comfort noise frames about every 400 ms (RFC 7587 / Opus DTX behaviour) [U].

### Cost and browser support

- Silero v5 runs in onnxruntime-web (WASM). Under 1 ms per frame natively [V]; WASM is probably 2-5x slower, still well under 1 percent of a core per user [U]. Measure it.
- Firefox supports AudioWorklet, WASM and onnxruntime-web [U; standard features]. onnxruntime-web's multi-threaded WASM needs cross-origin isolation (COOP/COEP) headers; use single-threaded WASM and no SharedArrayBuffer, which is plenty for this model [U].
- Serve the ONNX model and the .wasm files from your own origin (no CDN) and set the `application/wasm` MIME type.

## 2. Echo cancellation and gain

### Constraints

- All three constraints (`echoCancellation`, `noiseSuppression`, `autoGainControl`) default to true in browsers [U]. Set each explicitly.
- Turning all three off gives raw input and the lowest latency [S: Bugzilla 1375466 snippet].
- Chrome and Firefox both use libwebrtc's audio processing module (AEC3 in Chrome; Firefox ships its own vendored copy in `media/webrtc`) [V partly: Bugzilla 1656068 shows `webrtc/modules/audio_processing` vendored in Gecko; the AEC3 vs older AEC in the current Firefox version is [U]].
- Quality comparison: no head-to-head primary source found. Chrome's AEC3 is generally rated better than Firefox's, especially for double-talk and speakers [U]. Firefox echo bugs exist: 1627313 (echo to remote peers, Linux and Windows, headset-dependent, a DC offset confused the canceller, and a fix added a high-pass filter when processing is enabled) [V partly], 1506927 (a regression in Firefox 64) [S], 1407680 and 1263248 (older) [S]. Recommend headphones as the default and tell speaker users that echo is likely.

### The far-end audio path: Web Audio versus `<audio>`

- Chrome: AEC only uses WebRTC audio playout as its reference. Audio played through Web Audio (`AudioContext.destination`) or anything non-WebRTC is not cancelled [V: https://issues.chromium.org/issues/40445233, open request "Cancel echo from non-WebRTC output streams"]. Cancellation is also scoped per render frame and output device [V]. The discuss-webrtc thread reports flat AEC graphs for a Web Audio-wrapped call [S].
  - Rule: play remote tracks in `<audio>` elements with `srcObject` set to the remote stream. Do not route them through `createMediaStreamSource` to `destination` on Chrome.
  - If you need Web Audio processing on the far end (per-user volume, a limiter), Chrome's workaround is a local RTCPeerConnection loopback, so the processed stream arrives as a WebRTC remote track [S: Focused.io write-up]. That is extra complexity; avoid it. For per-user volume, use `<audio>.volume` (0 to 1 only).
  - Games being played (the Minecraft audio) are not a WebRTC output, so Chrome will not cancel them either, apart from the experimental "chrome-wide echo cancellation" flag [V: issue 40871060]. Speaker users will leak game audio into the mic. The denoiser and VAD must handle it; it is not solvable in the browser.
- Firefox: the AEC reverse stream is the audio played in the default MediaTrackGraph, from both media elements and AudioContext output [S: Bugzilla 1849108 and 694814 discussion; 1626081 comment calls it the complete mixed output]. So Web Audio output on the default device is a valid reference in Firefox [S; verify by test].
  - Gotcha [V: Bugzilla 1849108]: output to a non-default sink (`setSinkId`) is not fed to the AEC.
  - Safe rule for both browsers: use `<audio>` elements on the default output device.
- Check what was actually applied with `track.getSettings()` (`echoCancellation`, etc.). Firefox: `about:webrtc` has "Start AEC Logging" [V: from Bugzilla 1627313].

### Linux and PipeWire

- No Bugzilla or Chromium bug about PipeWire plus `echoCancellation` surfaced in searches [V: absence of results]. Treat it as untested. Practical risks [U]:
  - Browser AEC works on the software mix of the browser's own output, not on hardware loopback, so its delay estimation can drift with PipeWire's quantum and buffer size.
  - If the user also loads `module-echo-cancel` or a filter-chain system-wide, the two AECs stack. Tell Linux users not to.
  - Firefox cubeb picks the PulseAudio backend through pipewire-pulse; this is normally fine [U].
  - Mic source selection: remember `deviceId` per user and offer a device picker.
- Test matrix needed: Firefox on Arch (PipeWire), Chrome on Linux, Firefox and Chrome on Windows, each with headphones and with speakers.

### Auto gain control

- Browser AGC (libwebrtc's) pumps, and mechanical-keyboard peaks can drive its gain down or up unpredictably [U]. It also changes the level the VAD sees.
- Recommendation: AGC off, and give the user a manual input volume slider (GainNode) in front of the VAD, plus a level meter. Revisit if players have very quiet mics; test with `autoGainControl:true` against a fixed gain before deciding.

### Order with a WASM denoiser

- Keep browser AEC on, because it must see the mic signal first and nothing downstream can replicate it. A WASM denoiser has no far-end reference.
- Turn browser NS off. Two stacked suppressors cause artifacts and double-processed speech [U, widely held practice; no primary source]. Browser NS in Chrome is also tuned differently from Firefox's.
- Caveat: AEC output can contain residual echo that the denoiser will treat as speech. That is acceptable, since a user on headphones has none.
- Firefox: the DC-offset and high-pass finding in 1627313 suggests leaving at least one processing flag on (echoCancellation) rather than all off [S]. Keep AEC on.
- Because AEC and the worklet both add delay, the AEC reference alignment is unaffected: AEC acts at capture, before your worklet [U].

## 3. Opus over WebRTC

### Settings

| Setting | Recommendation | Notes |
|---|---|---|
| Channels | mono (`stereo=0`, `sprop-stereo=0`) | Voice does not need stereo; it doubles the bitrate. Opus in SDP is always declared as `opus/48000/2` per RFC 7587; the fmtp `stereo` flag chooses. |
| Bitrate | `maxaveragebitrate=32000` (about 24-40 kbps) | 32 kbps mono wideband/fullband voice is excellent. 24 is fine. Use more only for music. |
| In-band FEC | `useinbandfec=1` | Helps with modest loss. Recovers only the previous frame [S]. |
| DTX | `usedtx=1` | Saves bandwidth during silence, and makes the VAD gate act as a transmit gate. Firefox enables it only if the remote offers it [V: Bugzilla 1418804]. |
| ptime | 20 ms (default) | Larger ptime saves headers but adds latency. `ptime`/`maxptime` are honoured by Firefox [V partly: 1418804 summary]. |
| RED | optional, see below | |

### How to set it

- fmtp via SDP munging, applied to the `a=fmtp:111 ...` line (the payload type varies; read it from the SDP) in the offer and the answer. Example: `minptime=10;useinbandfec=1;usedtx=1;stereo=0;maxaveragebitrate=32000`.
- Firefox: `maxaveragebitrate` (accepted only between 6000 and 510000), `usedtx`, `useinbandfec`, `stereo`, `ptime`, `cbr` are parsed and passed to the encoder; fixed in Firefox 78 (Bugzilla 1418804) [V via fetch summary]. Note `usedtx` only takes effect if the remote offered it, so munge both directions.
- `RTCRtpSender.setParameters()`: `encodings[0].maxBitrate` was ignored for Opus in Firefox until the fix in 144 [S: Bugzilla 1573726, verified on 144.0b4 and 145 Nightly]. Fine on current versions. `encodings[0].dtx` exists in the spec [V: MDN]. Firefox support for the `dtx` parameter is [U]; use the fmtp `usedtx` instead.
- Since you control both ends (one web app), prefer SDP munging with fmtp for everything, and set `maxBitrate` in `setParameters` as a cap. Verify in `getStats()` (outbound-rtp bytesSent, `about:webrtc`) that the bitrate really follows.
- The cleaner option than munging is `setCodecPreferences` for ordering plus a small fmtp munge. Munging is allowed in practice, though the spec treats it as discouraged [U].

### RED (RFC 2198 redundant audio)

- Chrome: Opus+RED on by default since M96 [V: https://groups.google.com/g/discuss-webrtc/c/5761etCrSuA], payload type 63. It can be selected via `setCodecPreferences` by placing `red` before `opus` [V]. One redundant packet; large POLQA gain at low loss for little bandwidth [V].
- Firefox: no source found confirming `audio/red` support [V: absence]. Bugzilla 875922 only discusses video ulpfec/red, and a comment says audio RED was wanted [S]. Treat it as unsupported in Firefox. Check: `RTCRtpSender.getCapabilities('audio').codecs.filter(c=>c.mimeType.includes('red'))` in the target Firefox.
- Mixed Firefox and Chrome rooms: RED will not be negotiated on Firefox legs; the fallback to plain Opus is automatic. Do not depend on it. In-band FEC is the baseline, and for a 5-15 person LAN-like room it is plenty.

### Topology note

Not asked, but it matters here: a mesh of 5-15 peers means each client encodes once per peer (Opus is cheap) and uploads N-1 streams, which at 32 kbps is about 450 kbps at 15 users. That is fine. Check whether an SFU (e.g. Pion in Go, MIT) is needed [U; separate topic].

## Biggest risks

1. Chrome ignores Web Audio output as an AEC reference, and neither browser cancels the game's own audio. Speaker users will leak the game into the mic. Mitigation: `<audio>` elements, headphones recommended, and a good denoiser plus VAD.
2. Firefox AEC quality and Linux/PipeWire behaviour are untested here. A real test matrix is needed.
3. vad-web is not built for a live per-frame gate. Plan to wrap Silero yourself.
4. Firefox has no confirmed audio RED, so loss resilience relies on in-band FEC alone.

## Sources

- Silero VAD repo (MIT, size, speed): https://github.com/snakers4/silero-vad
- vad-web algorithm page: https://docs.vad.ricky0123.com/user-guide/algorithm/
- vad-web API page: https://docs.vad.ricky0123.com/user-guide/api/
- vad-web Silero v5 guide: https://github.com/ricky0123/vad/blob/master/docs/user-guide/silero-v5.md
- RNNoise plugin with VAD threshold guidance (werman): https://github.com/werman/noise-suppression-for-voice
- Discord Voice Input Modes: https://support.discord.com/hc/en-us/articles/211376518-Voice-Input-Modes-101-Push-to-Talk-Voice-Activated
- Chromium: cancel echo from non-WebRTC output: https://issues.chromium.org/issues/40445233
- Chromium: chrome-wide echo cancellation: https://issues.chromium.org/issues/40871060
- discuss-webrtc, Web Audio and AEC: https://groups.google.com/g/discuss-webrtc/c/NQ0f8MwwegQ
- Focused.io loopback workaround: https://focused.io/lab/echo-cancellation-with-web-audio-api-and-chromium
- Mozilla 1849108, feed non-default sinks to AEC: https://bugzilla.mozilla.org/show_bug.cgi?id=1849108
- Mozilla 694814, AEC in getUserMedia: https://bugzilla.mozilla.org/show_bug.cgi?id=694814
- Mozilla 1626081, microphone permission and audio: https://bugzilla.mozilla.org/show_bug.cgi?id=1626081
- Mozilla 1627313, echo from remote peers: https://bugzilla.mozilla.org/show_bug.cgi?id=1627313
- Mozilla 1506927, echo regression: https://bugzilla.mozilla.org/show_bug.cgi?id=1506927
- Mozilla 1375466, WebAudio latency: https://bugzilla.mozilla.org/show_bug.cgi?id=1375466
- Mozilla 1418804, Opus fmtp params: https://bugzilla.mozilla.org/show_bug.cgi?id=1418804
- Mozilla 1573726, maxBitrate for audio: https://bugzilla.mozilla.org/show_bug.cgi?id=1573726
- Mozilla 875922, video/audio red: https://bugzilla.mozilla.org/show_bug.cgi?id=875922
- RFC 7587, Opus RTP payload: https://tools.ietf.org/html/rfc7587
- RFC 8854, WebRTC FEC: https://datatracker.ietf.org/doc/html/rfc8854
- Opus+RED in Chrome M96: https://groups.google.com/g/discuss-webrtc/c/5761etCrSuA
- MDN RTCRtpSender.setParameters: https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters
- DEV Community AEC pitfalls (secondary): https://dev.to/orca_forge/browser-voice-interaction-ai-pitfall-guide-2026-16-common-traps-with-aec-getusermedia-and-40hd
