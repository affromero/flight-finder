# Flight Finder — desktop launcher

A tiny [Tauri](https://tauri.app) app that lets a non-developer run or reach
Flight Finder with no terminal. On first launch it asks how you want to use it:

- **Run it on this computer** (Host) — brings up the same Docker Compose stack
  the `curl | bash` installer creates in `~/.flight-finder`, waits for health,
  and opens the app. If nothing is installed yet, **Install & start** runs the
  official installer non-interactively.
- **Connect to an instance** (Client) — stores your instance URL and opens it in
  its own native window. The stack runs on your VPS; this is just the window.

The installer owns the Compose template, migrations, and provider setup. The
launcher reads the installed port, supports Docker Compose and standalone
Compose commands, and verifies HTTP health before opening the instance.

Windows host mode requires Docker Desktop or Podman with Compose, plus
[Git for Windows](https://gitforwindows.org/) with Git Bash. Remote client mode
does not require these tools.

New desktop installs bind to localhost. Choosing **Local network** recreates the
web container with a network binding. Choosing **This computer only** stops the
owned public tunnel and restores localhost binding. The launcher checks every
running web port binding before confirming the change. Existing command-line
installs retain their current binding until you change it explicitly.

## What the Rust side exposes

| Command | Action |
|---|---|
| `docker_available` | Is Docker or Podman installed? |
| `installed` | Is there a stack in `~/.flight-finder`? |
| `install_stack` | Run the official installer non-interactively (first-run bootstrap) |
| `start_stack` / `stop_stack` | `compose up -d` / `stop` in the install directory |
| `restart_stack` | Recreate containers to apply configuration changes |
| `connection` | Read the installed port and verify its running bindings |
| `set_reach` | Change the web binding and verify the running container |
| `is_healthy` | Check local application identity and health, with a version check for older instances |
| `open_app` | Open the installed local port in the default browser |
| `start_tunnel` / `stop_tunnel` | Start or stop only the launcher's own tunnel process |
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
npm test            # launcher UI and isolated installer checks
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run dev         # run the launcher in dev
npm run build       # produce an installer for the current OS
```

## Distribution

- **Source** lives here; the desktop app is **excluded from the npm workspaces**
  and from `npm run ci`. Desktop CI runs native tests on macOS, Linux, and
  Windows, plus the launcher UI tests.
- Shares the web app's version number (locked across all packages), tagged
  `desktop-v*` so a desktop release uses a distinct tag prefix from the `vX.Y.Z`
  web/GHCR release and never collides.
- Code signing / notarization (Apple Developer ID, Windows Authenticode) needs
  certificates added as the Tauri signing secrets documented at
  https://tauri.app/distribute/ before enabling signed release builds.
