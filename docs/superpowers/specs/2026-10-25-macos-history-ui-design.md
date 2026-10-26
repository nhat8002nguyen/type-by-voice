# macOS Transcription History UI Design

**Date:** 2026-10-25
**Status:** Design approved, pending spec review
**Depends on:** `2026-09-13-macos-client-design.md`, `2026-09-13-backend-design.md`
**Amends:** macOS signed-in window and Settings only.
No protocol or backend changes.

The signed-in macOS home window becomes a transcriptions list, visually aligned with the open-source Whisper-style recorder: search on top, cards in the body, a central dictation button, trash and settings at the bottom right.

## Goal

Replace `DashboardView` as the signed-in root with a server-backed history view.
Keep hotkey dictation inserting into other apps.
Use the in-window dictation button only to add items to the list.
Move account, quota, hotkey, and Quit into Settings.

## Non-goals

- Drop-audio-file to transcribe
- Mini recorder / extra bottom-left mic control
- Per-item delete
- Infinite scroll / loading pages beyond the first
- Local disk cache of transcripts
- Billing / Upgrade
- Changing the overlay pill for hotkey sessions
- Backend or protocol changes (`listInHistory` stays `true` on every `start`)

## Window and scenes

`TypeByVoiceApp` keeps three scenes: the Dock window `id: "main"`, the `MenuBarExtra`, and Settings.

Both the Dock window and the menu bar extra render the same signed-in root:

- `OnboardingView` while `model.showsWelcome`
- `HistoryView` otherwise

`DashboardView` is removed.
Default window size is 420 x 620 (minWidth 420, minHeight 520).
The menu bar extra uses the same view at 420 x 620.

Native traffic lights and the title "Type by Voice" stay.

## Components

| Component | Responsibility |
|---|---|
| `HistoryView` | Search field, card list, floating dictation button, trash, settings. Observes `AppModel` and `TranscriptHistoryStore`. |
| `TranscriptHistoryStore` | In-memory list, search query, loading/error status, expanded card id, optimistic prepend, load/search/deleteAll. Does not start recording. |
| `TranscriptsClient` | Authenticated HTTP: `GET /v1/transcripts` (`q`, `cursor`, `limit`) and `DELETE /v1/transcripts`. Sends `Authorization: Bearer`. |
| `SessionCoordinator` | Existing state machine, plus a per-session destination (see below). |
| `AppModel` | Wires hotkey vs in-window start, forwards `final` text to the store, opens Settings, quit. |
| `SettingsView` | Hotkey, launch at login, account email + log out, quota text, Quit. |

`AuthStore` stays the token owner.
`TranscriptsClient` receives a token provider and the API base URL.
It does not POST login itself.

Public list item shape matches the existing API:

```
{ id, text, wordCount, audioMs, createdAt }
```

## Session destination

Every session is one of:

- `.cursor` - hotkey path: transcribe, then `TextInserter.insert`, as today
- `.history` - in-window button: transcribe, skip insert

There is still only one session at a time.
`startOrStop` on AppModel takes the destination for a new idle-to-connecting transition.
A press that stops an in-flight session does not change that session's destination.

Hotkey always begins `.cursor`.
The in-window button begins `.history` when idle.
If a session is already active, the in-window button toggles stop on that session (same as today's dashboard Start/Stop).

On `final`:

1. Empty or whitespace-only text: go idle, add no card, insert nothing.
2. `.cursor`: insert, then notify the store with the text.
3. `.history`: skip insert, notify the store with the text, go idle.

`listInHistory` remains `true` on `start` for both destinations, so the server still persists the row.

Escape cancels either destination and adds no card.

## History data flow

On becoming signed-in, and when the history window becomes key, the store loads `GET /v1/transcripts?limit=50` (no `q`).
The first page is the whole list for this pass.
Newest first, as the API already returns.

Search: the field placeholder is "Search in transcriptions".
Typing is debounced 300 ms, then `GET /v1/transcripts?q=&limit=50`.
Clearing the field reloads the unfiltered list.
An in-flight search is cancelled when a newer query is sent.

On `final` text from AppModel:

1. Clear the search field so the new item is not hidden by an active filter.
2. Prepend an optimistic item (`id` is a local UUID, `createdAt` is now, `text` is the final string).
3. Refresh from the API (unfiltered).
4. Retry that refresh up to two more times, 500 ms apart, because workflows persistence is async via outbox.
5. If any successful page contains an item whose `text` equals the optimistic text, replace the in-memory list with the server page (drop the placeholder).
6. If retries still lack a match, keep the optimistic card on top of the last successful server page.
7. The next successful load or search that still lacks a matching `text` drops the placeholder so a ghost does not last forever.

Trash: confirmation alert ("Delete all transcriptions?" / Delete / Cancel).
On confirm, `DELETE /v1/transcripts`.
Clear the in-memory list only after success.

## UI

Search sits at the top, full width, rounded capsule, inset from the window edge.

The list is the main body, scrollable.
Each card has a rounded border, transcript text on top, a hairline, then date and time in secondary type on two lines.
Date and time use the user's locale (`DateFormatter` medium date, short time), stacked like the reference (`24 October 2026` / `21:58` in en-GB).

Clicking a card expands it in place.
The expanded body is selectable so the user can copy with Cmd+C.
Only one card is expanded.
Clicking the expanded card again collapses it.
No per-item delete button.

The dictation button is a large circle, floating above the list in the lower-middle of the window, not inside the scroll content.
Idle: solid blue.
Recording: filled and pulsing.
Transcribing: visually busy / non-idle, not a second start.
Click idle starts `.history`.
Click recording/connecting stops that session.

Bottom right: trash icon, then settings icon.
Settings sends the existing `showSettingsWindow:` / `showPreferencesWindow:` action and activates the app.
Bottom left is empty (no mini-recorder hint, no drop target, no extra mic).

Empty list (no items, or search with no hits): keep search, the dictation button, and the bottom icons.
Do not invent a placeholder card.

## Settings

Settings is the home for controls that left the dashboard:

- Hotkey recorder and the existing silence / hard-cap readouts
- Launch at login
- Account: email (or "Signed in"), Log out
- Usage: the same quota sentence as today's dashboard ("N words left" or "Quota updates after your next dictation.")
- Quit, which calls `AppModel.quit()`

Upgrade remains absent.

## Overlay pill

Hotkey (`.cursor`) sessions still drive the existing overlay pill.

`.history` sessions do not show the overlay pill.
Recording and error state for that path are shown on the dictation button and, when needed, a compact banner in `HistoryView`.
AppModel skips `overlay.render` while the active session destination is `.history`.

## Errors

History load/search failure: keep items already on screen; set a short status string in the list area ("Could not load transcriptions.").
No modal.

`DELETE` failure: do not clear the list; same status string for the failure.

`401` on `TranscriptsClient`: one `authStore.refreshIfNeeded()`, retry the same request once; if that fails, existing `forceReauthenticate` / onboarding path.

In-window session errors (mic denied, no input device, engine, timeouts): banner in `HistoryView` plus the button returning to idle.
Cancel and empty `final` add no card.

## Testing

Unit tests with fakes, no live backend:

- Store load fills items from a fake client.
- Search sends `q`.
- Delete-all clears only after the client succeeds; a failed delete keeps items.
- Failed load keeps existing items and sets the status string.
- `401` on the fake client causes one refresh-and-retry.
- Optimistic prepend appears immediately; a refetch that contains matching text replaces it with the server id; a refetch that never matches keeps it, and a later load without a match drops it.
- Coordinator: `.history` + non-empty `final` does not call `TextInserter`; `.cursor` still inserts; empty `final` inserts nothing and does not notify history.

AppModel: in-window start uses `.history`; hotkey start uses `.cursor`; both forward `final` text to the store.

Manual verification after implementation:

- Signed-in window matches the reference layout (search, cards, center button, trash + settings).
- In-window dictation appears in the list and does not paste into another app.
- Hotkey still pastes and the new item appears in the list.
- Search filters.
- Trash confirms and empties.
- Settings shows account, quota, hotkey, Quit.
- Menu bar extra shows the same history view.
- Overlay pill still appears for hotkey dictation and does not appear for in-window dictation.
