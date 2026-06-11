# Flight Finder — desktop launcher

A tiny [Tauri](https://tauri.app) app that lets a non-developer run or reach
Flight Finder with no terminal. On first launch it asks how you want to use it:

- **Run it on this computer** (Host) — brings up the same Docker Compose stack
  the `curl | bash` installer creates in `~/.flight-finder`, waits for health,
  and opens the app. If nothing is installed yet, **Install & start** runs the
  official installer non-interactively.
- **Connect to an instance** (Client) — stores your instance URL and opens it in
  its own native window. The stack runs on your VPS; this is just the window.

It is a **thin shell**: the Rust side never reimplements the compose file or the
installer logic (Docker/Podman detection, port handling, migrations, VPN). Those
live in `apps/web/public/install.sh` and are guarded by the pre-release test
harness. Errors from Docker or the installer surface in the UI; there is no
silent fallback.

## What the Rust side exposes

| Command | Action |
|---|---|
| `docker_available` | Is Docker or Podman installed? |
| `installed` | Is there a stack in `~/.flight-finder`? |
| `install_stack` | Run the official installer non-interactively (first-run bootstrap) |
| `start_stack` / `stop_stack` | `compose up -d` / `down` in `~/.flight-finder` |
| `is_healthy` | TCP probe of the web port (3003) |
| `open_app` | Open `http://localhost:3003` in the default browser (Host) |
| `save_server` / `load_server` | Persist the Client-mode instance URL |
| `open_client` | Open a remote instance in its own native window |

UI is plain HTML/JS in `src/` talking to those commands via the global Tauri
bridge.

## Build it (needs the Rust + Tauri toolchain)

> This repo ships the source. Signed installers are produced by
> `.github/workflows/desktop-release.yml` on a `desktop-v*` tag.

```bash
# Prerequisites: Rust (https://rustup.rs) + Tauri v2 system deps
#   https://tauri.app/start/prerequisites/
cd apps/desktop
npm install
npm run icon        # generate src-tauri/icons/* from ../web/public/icon.svg (one-time)
npm run dev         # run the launcher in dev
npm run build       # produce an installer for the current OS
```

## Distribution

- **Source** lives here; the desktop app is **excluded from the npm workspaces**
  and from `npm run ci` (it is a Rust/Cargo build driven by the release
  workflow, not root CI).
- Shares the web app's version number (locked across all packages), tagged
  `desktop-v*` so a desktop release uses a distinct tag prefix from the `vX.Y.Z`
  web/GHCR release and never collides.
- Code signing / notarization (Apple Developer ID, Windows Authenticode) needs
  certificates added as the Tauri signing secrets documented at
  https://tauri.app/distribute/ before enabling signed release builds.

## Status

The launcher and release pipeline are complete in source. They have **not been
compiled or signed in this environment** (the Tauri CLI and icon generation are
not available here). Build once on a machine with the toolchain (or via the
workflow) to produce installers.
