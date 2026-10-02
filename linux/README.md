# Type by Voice — Linux client

A single-instance GTK4 tray agent that records from the microphone, streams Ogg
Opus to the shared backend over the dictation v1 protocol, and inserts the
transcript at the cursor. Speaks the same contract as the macOS client with
`platform: "linux"`.

Spec: [`docs/superpowers/specs/2026-10-02-linux-client-design.md`](../docs/superpowers/specs/2026-10-02-linux-client-design.md).

**Supported:** Ubuntu 22.04 LTS (floor) through 24.04 / 24.10 / 25.04, amd64.
Full shortcut + insertion parity needs **X11**; on a Wayland session the shortcut
becomes click-to-record and insertion falls back to the clipboard (see
*Wayland* below).

## Build and run in an Ubuntu VM (from an Apple-Silicon Mac)

### 1. Create the VM (UTM)

- UTM (free) → **Create a New Virtual Machine → Virtualize → Linux**, and boot
  the **Ubuntu 24.04 ARM64** desktop ISO. Add a second VM with **22.04 ARM64**
  if you want to check the floor.
- Give it 4 GB RAM and 40 GB disk. Install Ubuntu normally.

> The archive hosted at `cdimage.ubuntu.com/.../arm64` boots under UTM on Apple
> Silicon. Parallels works too; UTM is the free option.

### 2. Install the toolchain and build dependencies

```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential git pkg-config curl \
  libgtk-4-dev libayatana-appindicator3-dev \
  libpulse-dev libasound2-dev libopus-dev \
  libx11-dev libxtst-dev
```

Install Go (Ubuntu's `golang` package is often too old; use the tarball):

```bash
GO=1.24.5
curl -fsSLo /tmp/go.tgz https://go.dev/dl/go${GO}.linux-arm64.tar.gz
sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf /tmp/go.tgz
export PATH=$PATH:/usr/local/go/bin     # add to ~/.profile to keep it
go version                               # expect go1.24.x
```

### 3. Get the code and build

```bash
git clone git@github.com:nhat8002nguyen/type-by-voice.git
cd type-by-voice
git checkout feat/linux-client
cd linux

# Pure-Go core (no cgo) — fast, no GTK needed:
CGO_ENABLED=0 go test ./core/...

# The shell (needs the apt packages above):
CGO_ENABLED=1 go test ./app/...
CGO_ENABLED=1 go build -trimpath -o typebyvoice ./cmd/typebyvoice
```

### 4. Point it at a backend and run

The client picks endpoints from the environment, falling back to localhost:

```bash
# Against the deployed API:
TBV_API_URL=https://api.<your-host> \
TBV_DICTATE_URL=wss://api.<your-host>/v1/dictate \
./typebyvoice
```

Or run the backend locally (`docker compose up` in `backend/`) and just run
`./typebyvoice` — it defaults to `http://127.0.0.1:3000`.

On first run the tray icon appears (Ubuntu's GNOME ships the AppIndicator
extension enabled). Use **Settings** to sign in; the account-email hint and
tokens are stored under `~/.config/typebyvoice/` and the Secret Service.

### 5. Install the packaged artifacts

CI produces both; build them into `linux/build/` (or grab the CI artifacts):

```bash
# AppImage — self-contained, no install:
chmod +x build/typebyvoice-0.1.0-amd64.AppImage
./build/typebyvoice-0.1.0-amd64.AppImage

# .deb — native install:
sudo apt-get install ./build/typebyvoice_0.1.0_amd64.deb
typebyvoice
```

## Verification checklist

Log in to an **X11 session** first (*Ubuntu on Xorg* at the login screen) for
full parity, then verify each item:

1. **Hotkey parity** — press `Ctrl+Shift+Space`; the pill shows **Connecting**,
   then **Listening**. Press it again; the transcript appears at the cursor.
2. **Insertion matrix** — dictate a short phrase into each of: Gedit, VS Code,
   GNOME Terminal, and a browser text field. Each time, confirm the text lands
   and that the previous clipboard contents come back after ~150 ms.
3. **Clipboard manager** — repeat with a manager running (CopyQ or the GNOME
   clipboard extension) and confirm the restore still happens.
4. **Leading-word safety** — press the hotkey and speak *immediately*; the first
   words must not be dropped (the pill must not show a live level until it is
   actually listening).
5. **Silence auto-stop** — speak, then go quiet for ~3 s; it should transcribe
   on its own.
6. **No-speech / short press** — press and release without speaking; nothing is
   inserted and no request is billed.
7. **Escape** — press Escape while recording; nothing is inserted.
8. **Pill focus** — click into a text field, then trigger dictation and confirm
   keyboard focus does **not** move to the pill while it appears.
9. **Dashboard** — open History from the tray; search, delete, and export work.
10. **Single instance** — launch `typebyvoice` again; the second process exits
    and the first stays up.

## Wayland

On a Wayland session (`XDG_SESSION_TYPE=wayland`) the compositor blocks global
key grabs and synthesized keystrokes by design:

- The tray/pill becomes **click-to-record** (no global shortcut).
- Insertion uses `wtype` when it is installed
  (`sudo apt-get install wtype`), and otherwise leaves the transcript on the
  clipboard with a “press Ctrl+V” notification.

For the full macOS-like experience, log in to **Ubuntu on Xorg**.

## Packaging

- `packaging/appimage/` — `AppRun` + `typebyvoice.desktop` for the AppImage.
- `packaging/debian/` — `control` + `postinst` for the `.deb`.
- `build/` — build output (git-ignored).
- CI: [`.github/workflows/linux-client.yml`](../.github/workflows/linux-client.yml)
  builds both on `ubuntu-24.04` and runs the contract smoke test.

## Settings and files

| Path | What |
|---|---|
| `~/.config/typebyvoice/settings.json` | hotkey, silence threshold, hard cap, insertion mode, microphone, launch-at-login |
| `~/.config/typebyvoice/autostart/typebyvoice.desktop` | launch-at-login entry |
| `~/.local/state/typebyvoice/instance.lock` | single-instance lock |
| `~/.local/state/typebyvoice/device-id` | stable per-install device UUID |
| Secret Service | access + refresh tokens |
