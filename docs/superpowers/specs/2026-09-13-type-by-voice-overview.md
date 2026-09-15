# Type by Voice — System Overview

**Date:** 2026-09-13
**Amended:** 2026-09-14 — backend and protocol are a shared contract for every official client, not Mac-only. Listening indicator waits for mic + `ready`; pre-`ready` audio is buffered.
**Status:** Design approved, pending spec review
**Supersedes:** `initial-idea.md` (which assumed local on-device Whisper inference)

## Product

A dictation tool. The user starts recording, speaks, and the transcribed text is
inserted at the current cursor (or the platform equivalent). Speed, accuracy,
and low client resource consumption are the priorities. Feature count is
explicitly not a priority.

**v1 ships a macOS client** (global hotkey, menu-bar agent). Windows, Android,
and iOS clients are planned, not shipped. Transcription runs server-side. Any
official client records, encodes, and uploads audio; the backend transcribes and
returns text. That keeps every client small and is what lets later platforms
reuse the same API.

## Scope of v1

**In scope:**

- Menu-bar-only macOS client (no Dock icon, no main window)
- Global hotkey, toggle-style recording with silence auto-stop
- Floating pill overlay showing connecting, then listening level, then transcription progress
- English transcription, raw model output with no post-processing
- Text insertion at cursor via clipboard paste, with clipboard-only fallback
- Backend gateway streaming audio to a hosted speech provider
- Email/password accounts with verified addresses
- Word-based weekly quota with plan-driven configuration
- Server-side transcript history with search, delete, and export
- Shared HTTP API and dictation protocol that accept `macos` now and `windows` / `ios` / `android` later

**Explicitly out of scope for v1:**

- Languages other than English (the design must not preclude them)
- Offline transcription of any kind
- Live partial transcripts appearing while speaking
- Text post-processing (filler removal, custom vocabulary, LLM formatting)
- Subscription billing (the data model must accommodate it)
- Shipping the course `alarms-generator` app
- Code signing, notarization, auto-update, App Store distribution
- Shipping Windows, Android, or iOS clients (the API must already accept them)
- Multi-region deployment

## Clients and one contract

| System | Language | Deploy target |
|---|---|---|
| macOS client (v1) | Swift 6 / SwiftUI, Xcode 26 | macOS 13.0+, Intel and Apple Silicon |
| Windows / Android / iOS | Not chosen | Not shipped in v1; same HTTP + dictation protocol |
| Backend | Nest.js 12 monorepo / TypeScript (not JavaScript) / Node 24 LTS | Docker `node:24-alpine`, Singapore; patterns from `nestjs-microservices/`, not its versions |

Clients couple to the backend only through the versioned HTTP API and the
WebSocket protocol in `2026-09-13-dictation-protocol.md`. Platform-specific
behaviour (Keychain, hotkeys, text insertion, notifications) lives in the client
design for that platform, never in the backend contract. Each client has — or
will have — its own design document and can be built independently as long as
the contract holds.

Official `platform` values: `macos`, `windows`, `ios`, `android`. A new value is
added on the server before any client sends it.

## Decisions and rationale

| Decision | Rationale |
|---|---|
| Nest.js microservices for the backend | Course skeleton for topology; product uses Nest 12 + TypeScript + Node 24 LTS (`node:24-alpine`). `nest new` default language; never `--language js` |
| Server-side transcription | Keeps every client light; supports Intel Macs and later phones/PCs; enables a commercial model |
| Shared HTTP + WebSocket contract | One backend for Mac now and Windows/Android/iOS later; clients identify with `platform`, `clientVersion`, `deviceId` |
| Stream audio during recording, transcribe in one batch on stop | Upload finishes while the user talks, so only inference latency remains. Batch billing charges for audio, not wall-clock connection time — roughly 5–20x cheaper than streaming ASR for short dictations |
| Groq-hosted Whisper as first provider | ~$0.02–0.04 per audio-hour with ~300ms round trips. Behind an adapter interface so a second provider is additive |
| Opus at ~24 kbps | ~3 KB per second of speech instead of 32 KB raw. Makes the app usable on weak networks |
| Ogg Opus container produced client-side | The provider's batch endpoint accepts Ogg files directly, so the server never muxes audio |
| Toggle recording plus 3s silence auto-stop | User preference. Manual stop is the low-latency path |
| Every non-idle state has a timeout | A dictation tool that can hang is worse than one that fails |
| Connecting until mic frames + server `ready`, then Listening | Do not look live while the socket or audio route is still coming up. Buffer from the first sample so leading words are not dropped. On Mac with a warm engine this is tens of milliseconds; iOS speaker/mic route changes can take 1–2 s |
| Clipboard paste for insertion | The accessibility-API approach fails in Electron apps, terminals, and browsers — most of where dictation happens |
| Carbon `RegisterEventHotKey` for the hotkey | Avoids requiring Input Monitoring permission; only Accessibility is needed, and only for pasting |
| No offline fallback | User decision. Offline shows a clear error |
| Words as the user-facing quota unit | Understandable to users. A separate, generous audio-minute ceiling protects margins |
| Finish the current utterance, then hard-block | A dictation that started under the limit always completes. The next `start` is refused until reset or upgrade. Never cut a sentence mid-stream |
| Plans as database rows | Adding paid tiers becomes a data change, not a logic change |
| Transcripts stored server-side | Enables searchable history as a product feature. Requires encryption at rest, delete/export, and a privacy policy |

## Latency budget

Target: text appears at the cursor within 3 seconds of the user stopping.
Expected performance is well inside that.

| Stage | Expected |
|---|---|
| Hotkey to capture start | <20 ms (audio engine pre-warmed at launch); buffered, not uploaded yet |
| Hotkey to Listening indicator | Capture live **and** `ready`. Warm socket: tens of ms. Cold connect or mobile audio-route change: up to ~1–2 s |
| Audio upload | ~0 ms perceived once Listening (overlaps speech; pre-`ready` buffer flushed first) |
| Provider inference | ~250–400 ms |
| Network round trip (Singapore) | ~30–80 ms |
| Clipboard insertion | <100 ms |

Silence auto-stop adds its full 3-second wait by definition. Manual stop avoids
it.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Round-trip latency on real networks is worse than estimated | High | The first thing built is an end-to-end latency harness measuring p50/p95 per stage. If it fails the budget, revisit before building features |
| Single provider means a provider outage is a total outage | High | Provider adapter interface from day one; add a second adapter before any real user base |
| Forgotten open microphone becomes a billable event | Medium | Hard duration cap, no-speech abort, per-user audio-minute ceiling |
| Stored transcripts create breach liability | Medium | Encryption at rest, no transcript content in logs, working delete and export |
| Clipboard save/restore races with clipboard-manager apps | Medium | Tune restore delay against real apps; document known-incompatible apps |
| Quota word counts disagree between client and server | Low | Server is the sole counter; the client only displays what it is told |
| User speaks before the mic route or socket is live; first words drop | Medium | Pill stays on Connecting until frames + `ready`; local buffer is flushed on `ready`; Connecting times out at 5 s |

## Cost model

At Groq rates, the 2000-words-per-week free tier is roughly one audio-hour per
month per active user, or about $0.04. Free-tier transcription cost is not a
material risk; infrastructure and abuse are the things to watch.

## Build order

1. End-to-end latency harness (validates the riskiest assumption)
2. Protocol implementation on both sides, with shared fixtures
3. Backend (`api`, `quota-service`, `speech-service`, `workflows-service`, `notifications-service`)
4. macOS client: capture pipeline, state machine, insertion, pill, onboarding
5. Transcript history, search, export
6. Subscription billing (post-v1)
