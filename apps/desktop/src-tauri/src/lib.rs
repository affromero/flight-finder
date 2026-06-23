//! Flight Finder desktop launcher.
//!
//! The Rust side is intentionally thin. It is a shell over the canonical Docker
//! stack that the installer (`install.sh`) and the `flight-finder` CLI manage in
//! `~/.flight-finder` -- it never reimplements the compose file, the `.env`, the
//! Docker/Podman detection, or the migration logic (those live in install.sh and
//! are guarded by the pre-release test harness). Two modes:
//!
//!   * Host   -- bootstrap and run the stack on this machine, open it locally.
//!   * Client -- open a remote instance (a VPS) in its own native window.
//!
//! All UI lives in the webview (../src). Errors from Docker/installer are
//! propagated to the UI verbatim -- there is no silent fallback.

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Install directory used by install.sh. Honors `FLIGHT_FINDER_DIR` (the same
/// override install.sh respects) and otherwise defaults to `~/.flight-finder`.
fn install_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("FLIGHT_FINDER_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    PathBuf::from(home).join(".flight-finder")
}

/// macOS (and Linux) GUI apps launched from Finder/the dock do NOT inherit the
/// shell PATH -- they get a minimal one (e.g. /usr/bin:/bin:/usr/sbin:/sbin), so
/// docker/podman/cloudflared installed in /usr/local/bin or /opt/homebrew/bin
/// are invisible. Build a PATH that includes the common install locations and
/// apply it to every spawned command.
fn augmented_path() -> String {
    let mut parts: Vec<String> = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    // Docker Desktop / Rancher Desktop install their CLI under the home dir on
    // some setups, which is in none of the standard dirs above.
    if let Ok(home) = std::env::var("HOME") {
        parts.push(format!("{home}/.docker/bin"));
        parts.push(format!("{home}/.rd/bin"));
    }
    if let Ok(existing) = std::env::var("PATH") {
        if !existing.is_empty() {
            parts.push(existing);
        }
    }
    parts.join(":")
}

/// An OS-appropriate hint for installing a command-line tool the user is missing.
fn install_hint(tool: &str) -> String {
    if cfg!(target_os = "macos") {
        format!("install it with: brew install {tool}")
    } else if cfg!(target_os = "windows") {
        format!("install it with: winget install {tool} (or see its downloads page)")
    } else {
        format!("install {tool} with your package manager (apt/dnf/pacman) or its downloads page")
    }
}

/// Resolve a binary to an absolute path using the augmented PATH.
fn which(name: &str) -> Option<String> {
    for dir in augmented_path().split(':') {
        if dir.is_empty() {
            continue;
        }
        let candidate = std::path::Path::new(dir).join(name);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

/// A Command with the augmented PATH applied, so the spawned process and its
/// children (the docker compose plugin, curl, etc.) resolve correctly.
fn command(program: &str) -> Command {
    let mut c = Command::new(program);
    c.env("PATH", augmented_path());
    c
}

/// Prefer the docker CLI, fall back to podman -- the installer supports both.
/// Returns the absolute path so it works without the shell PATH.
fn container_cmd() -> Option<String> {
    which("docker").or_else(|| which("podman"))
}

/// Run `<docker|podman> compose <args>` inside the install dir.
fn compose(cmd: &str, args: &[&str]) -> std::io::Result<std::process::Output> {
    command(cmd)
        .arg("compose")
        .args(args)
        .current_dir(install_dir())
        .output()
}

#[tauri::command]
fn docker_available() -> bool {
    container_cmd().is_some()
}

#[tauri::command]
fn installed() -> bool {
    install_dir().join("docker-compose.yml").exists()
}

/// Download and run the official installer non-interactively. This is the
/// canonical bootstrap: it writes `~/.flight-finder`, pulls the image, and
/// starts the stack. The launcher never duplicates that logic.
#[tauri::command]
fn install_stack() -> Result<String, String> {
    let script =
        "curl -fsSL https://flight-finder.org/install.sh | FLIGHT_FINDER_YES=1 FLIGHT_FINDER_OPEN_BROWSER=0 bash";
    let out = command("/bin/bash")
        .arg("-lc")
        .arg(script)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok("installed".into())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

#[tauri::command]
fn start_stack() -> Result<String, String> {
    let cmd = container_cmd().ok_or("Docker or Podman is required.")?;
    let out = compose(&cmd, &["up", "-d"]).map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok("started".into())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

#[tauri::command]
fn stop_stack() -> Result<String, String> {
    let cmd = container_cmd().ok_or("Docker or Podman is required.")?;
    let out = compose(&cmd, &["down"]).map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok("stopped".into())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

/// Recreate the stack so an edited `~/.flight-finder/.env` is reloaded. A plain
/// `up -d` does not recreate containers on an env_file content change, so a user
/// who edits .env and just restarts would otherwise keep the stale environment.
/// `down` then `up -d --force-recreate` guarantees the new env is picked up.
#[tauri::command]
fn restart_stack() -> Result<String, String> {
    let cmd = container_cmd().ok_or("Docker or Podman is required.")?;
    restart_with(&cmd)
}

/// Recreate the stack with a resolved container command. Split out from the
/// tauri command so it can be tested with a fake container binary.
fn restart_with(cmd: &str) -> Result<String, String> {
    // `down` may exit non-zero if nothing is running; that is fine, only the
    // bring-up result decides success.
    let _ = compose(cmd, &["down"]).map_err(|e| e.to_string())?;
    let out = compose(cmd, &["up", "-d", "--force-recreate"]).map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok("restarted".into())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

/// A TCP connect to the published port is enough to know the app is up.
#[tauri::command]
fn is_healthy(port: u16) -> bool {
    std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

/// Open the locally running app in the user's default browser (Host mode).
#[tauri::command]
fn open_app(port: u16) -> Result<(), String> {
    open_in_browser(&format!("http://localhost:{port}"))
}

// --------------------------------------------------------------------------
// Reachability (Host mode): consent-first. Nothing here exposes the instance
// unless the user explicitly picks it in the UI.
// --------------------------------------------------------------------------

/// The instance's URL on the local network, for same-WiFi devices.
#[tauri::command]
fn lan_url(port: u16) -> Option<String> {
    let ip = if cfg!(target_os = "macos") {
        ["en0", "en1"].iter().find_map(|iface| {
            Command::new("ipconfig")
                .args(["getifaddr", iface])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty())
        })
    } else if cfg!(target_os = "windows") {
        None
    } else {
        Command::new("hostname")
            .arg("-I")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .split_whitespace()
                    .next()
                    .map(|s| s.to_string())
            })
    };
    ip.map(|ip| format!("http://{ip}:{port}"))
}

/// Start a Cloudflare quick tunnel and return its public https URL. This exposes
/// the instance to the public internet, so the UI calls it only on an explicit
/// user action (a button behind a clear warning). Output is written to a log
/// file (not a pipe) so cloudflared never blocks on a full stderr buffer.
#[tauri::command]
fn start_tunnel(app: tauri::AppHandle, port: u16) -> Result<String, String> {
    let cloudflared = which("cloudflared")
        .ok_or_else(|| format!("cloudflared isn't installed -- {}, then try again.", install_hint("cloudflared")))?;

    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let log_path = dir.join("tunnel.log");
    let _ = fs::remove_file(&log_path);
    let out = fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let err = out.try_clone().map_err(|e| e.to_string())?;

    command(&cloudflared)
        .args([
            "tunnel",
            "--protocol",
            "http2",
            "--url",
            &format!("http://localhost:{port}"),
        ])
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .spawn()
        .map_err(|e| e.to_string())?;

    // Poll the log for the assigned URL (cloudflared prints it within seconds).
    for _ in 0..40 {
        thread::sleep(Duration::from_millis(500));
        if let Ok(content) = fs::read_to_string(&log_path) {
            if let Some(idx) = content.find("https://") {
                let url: String = content[idx..]
                    .chars()
                    .take_while(|c| !c.is_whitespace())
                    .collect();
                if url.contains("trycloudflare.com") {
                    return Ok(url);
                }
            }
        }
    }
    let _ = stop_tunnel();
    Err("The tunnel did not report a URL in time. Check your network and try again.".into())
}

/// Stop any quick tunnel this app started.
#[tauri::command]
fn stop_tunnel() -> Result<(), String> {
    let _ = command("pkill").args(["-f", "cloudflared tunnel"]).output();
    Ok(())
}

// --------------------------------------------------------------------------
// Client mode: remember a server URL and open it in its own native window.
// --------------------------------------------------------------------------

fn server_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("server-url.txt"))
}

#[tauri::command]
fn save_server(app: tauri::AppHandle, url: String) -> Result<(), String> {
    fs::write(server_file(&app)?, url.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_server(app: tauri::AppHandle) -> Option<String> {
    let path = server_file(&app).ok()?;
    let value = fs::read_to_string(path).ok()?;
    let trimmed = value.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// Open a remote Flight Finder instance in its own native window.
#[tauri::command]
fn open_client(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(url.trim()).map_err(|_| format!("Not a valid URL: {url}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("Unsupported URL scheme: {other}")),
    }
    // Reuse the window if it is already open.
    if let Some(existing) = app.get_webview_window("client") {
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "client", WebviewUrl::External(parsed))
        .title("Flight Finder")
        .inner_size(1180.0, 820.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn open_in_browser(url: &str) -> Result<(), String> {
    let spawned = if cfg!(target_os = "macos") {
        Command::new("open").arg(url).spawn()
    } else if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", "start", "", url]).spawn()
    } else {
        Command::new("xdg-open").arg(url).spawn()
    };
    spawned.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            docker_available,
            installed,
            install_stack,
            start_stack,
            stop_stack,
            restart_stack,
            is_healthy,
            open_app,
            lan_url,
            start_tunnel,
            stop_tunnel,
            save_server,
            load_server,
            open_client
        ])
        .run(tauri::generate_context!())
        .expect("error while running Flight Finder");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// restart_with must recreate the stack: `compose down` first, then
    /// `compose up -d --force-recreate` (a plain `up -d` would not reload an
    /// edited env_file). Drive it with a fake container binary that records its
    /// args, and point FLIGHT_FINDER_DIR at a temp dir so compose() has a real
    /// working directory. #151.
    #[test]
    fn restart_runs_down_then_force_recreate_up_in_order() {
        let tmp = std::env::temp_dir().join(format!("ff-restart-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("FLIGHT_FINDER_DIR", &tmp);

        let log = tmp.join("calls.log");
        let _ = std::fs::remove_file(&log);
        let shim = tmp.join("fake-container.sh");
        std::fs::write(&shim, format!("#!/bin/sh\necho \"$@\" >> \"{}\"\n", log.display())).unwrap();
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();

        let res = restart_with(shim.to_str().unwrap());
        assert!(res.is_ok(), "restart_with errored: {res:?}");

        let calls = std::fs::read_to_string(&log).unwrap();
        let lines: Vec<&str> = calls.lines().collect();
        assert_eq!(lines, vec!["compose down", "compose up -d --force-recreate"]);

        std::env::remove_var("FLIGHT_FINDER_DIR");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
