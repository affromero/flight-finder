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
use std::process::Command;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Default install directory used by install.sh (`~/.flight-finder`).
fn install_dir() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    PathBuf::from(home).join(".flight-finder")
}

/// Prefer the docker CLI, fall back to podman -- the installer supports both.
fn container_cmd() -> Option<&'static str> {
    for cmd in ["docker", "podman"] {
        let ok = Command::new(cmd)
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ok {
            return Some(cmd);
        }
    }
    None
}

/// Run `<docker|podman> compose <args>` inside the install dir.
fn compose(cmd: &str, args: &[&str]) -> std::io::Result<std::process::Output> {
    Command::new(cmd)
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
    let out = Command::new("bash")
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
    let out = compose(cmd, &["up", "-d"]).map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok("started".into())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

#[tauri::command]
fn stop_stack() -> Result<String, String> {
    let cmd = container_cmd().ok_or("Docker or Podman is required.")?;
    let out = compose(cmd, &["down"]).map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok("stopped".into())
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
            is_healthy,
            open_app,
            save_server,
            load_server,
            open_client
        ])
        .run(tauri::generate_context!())
        .expect("error while running Flight Finder");
}
