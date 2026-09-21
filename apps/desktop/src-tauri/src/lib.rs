//! Native launcher for the canonical installer and Compose stack.
mod runtime;

use runtime::{command, install_dir, prepare_access, which, Compose, Tunnel};
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn docker_available() -> bool {
    Compose::detect().is_ok()
}

#[tauri::command]
fn installed() -> bool {
    install_dir().is_ok_and(|dir| dir.join("docker-compose.yml").exists())
}

#[tauri::command]
fn connection() -> Result<runtime::Connection, String> {
    let dir = install_dir()?;
    let connection = runtime::connection(&dir)?;
    runtime::verify_binding(&Compose::detect()?, &dir, connection.local_only)?;
    Ok(connection)
}

#[tauri::command]
async fn install_stack() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(runtime::bootstrap)
        .await
        .map_err(|error| error.to_string())?
}

fn stack_action(args: &[&str]) -> Result<String, String> {
    Compose::detect()?.run(&install_dir()?, args)
}

#[tauri::command]
async fn start_stack() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = install_dir()?;
        let compose = Compose::detect()?;
        prepare_access(&compose, &dir)?;
        compose.run(&dir, &["up", "-d"])
    })
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn stop_stack(state: tauri::State<'_, Mutex<Tunnel>>) -> Result<String, String> {
    state.lock().map_err(|error| error.to_string())?.stop()?;
    tauri::async_runtime::spawn_blocking(|| stack_action(&["stop"]))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn restart_stack(state: tauri::State<'_, Mutex<Tunnel>>) -> Result<String, String> {
    state.lock().map_err(|error| error.to_string())?.stop()?;
    tauri::async_runtime::spawn_blocking(|| {
        let dir = install_dir()?;
        let compose = Compose::detect()?;
        prepare_access(&compose, &dir)?;
        compose.run(&dir, &["up", "-d", "--force-recreate"])
    })
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn set_reach(
    local_only: bool,
    state: tauri::State<'_, Mutex<Tunnel>>,
) -> Result<runtime::Connection, String> {
    state.lock().map_err(|error| error.to_string())?.stop()?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = install_dir()?;
        let compose = Compose::detect()?;
        runtime::set_binding(&dir, local_only)?;
        prepare_access(&compose, &dir)?;
        compose.run(&dir, &["up", "-d", "--force-recreate", "--no-deps", "web"])?;
        runtime::verify_binding(&compose, &dir, local_only)?;
        runtime::connection(&dir)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn is_healthy() -> Result<bool, String> {
    let port = runtime::connection(&install_dir()?)?.port;
    tauri::async_runtime::spawn_blocking(move || runtime::is_healthy(port))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_app() -> Result<(), String> {
    open_in_browser(&format!(
        "http://localhost:{}",
        runtime::connection(&install_dir()?)?.port
    ))
}

#[tauri::command]
fn lan_url() -> Result<Option<String>, String> {
    // A UDP route lookup chooses the active interface without transmitting data.
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").map_err(|error| error.to_string())?;
    if socket.connect("192.0.2.1:80").is_err() {
        return Ok(None);
    }
    let ip = socket.local_addr().map_err(|error| error.to_string())?.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        return Ok(None);
    }
    Ok(Some(format!(
        "http://{ip}:{}",
        runtime::connection(&install_dir()?)?.port
    )))
}

#[tauri::command]
async fn start_tunnel(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cloudflared = which("cloudflared").ok_or("Install cloudflared and reopen Flight Finder before opening a public link.")?;
        let state = app.state::<Mutex<Tunnel>>();
        let mut tunnel = state.lock().map_err(|error| error.to_string())?;
        tunnel.stop()?;
        let dir = app.path().app_config_dir().map_err(|error| error.to_string())?;
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        let log_path = dir.join("tunnel.log");
        let out = fs::File::create(&log_path).map_err(|error| error.to_string())?;
        let err = out.try_clone().map_err(|error| error.to_string())?;
        let port = runtime::connection(&install_dir()?)?.port;
        tunnel.child = Some(command(cloudflared).args(["tunnel", "--protocol", "http2", "--url", &format!("http://localhost:{port}")])
            .stdout(Stdio::from(out)).stderr(Stdio::from(err)).spawn().map_err(|error| error.to_string())?);
        for _ in 0..40 {
            if tunnel.child.as_mut().ok_or("Tunnel process is missing")?.try_wait().map_err(|error| error.to_string())?.is_some() {
                tunnel.stop()?;
                return Err("The tunnel exited before opening a public link. Check its configuration and network.".into());
            }
            if let Ok(log) = fs::read_to_string(&log_path) {
                if let Some(url) = runtime::tunnel_url(&log) { return Ok(url); }
            }
            thread::sleep(Duration::from_millis(500));
        }
        tunnel.stop()?;
        Err("The tunnel did not report a URL in time. Check your network and try again.".into())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
fn stop_tunnel(state: tauri::State<'_, Mutex<Tunnel>>) -> Result<(), String> {
    state.lock().map_err(|error| error.to_string())?.stop()
}

fn server_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("server-url.txt"))
}

#[tauri::command]
fn save_server(app: tauri::AppHandle, url: String) -> Result<(), String> {
    fs::write(server_file(&app)?, url.trim()).map_err(|error| error.to_string())
}

#[tauri::command]
fn load_server(app: tauri::AppHandle) -> Option<String> {
    let value = fs::read_to_string(server_file(&app).ok()?).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[tauri::command]
fn open_client(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(url.trim()).map_err(|_| "Enter a valid instance URL")?;
    if !["http", "https"].contains(&parsed.scheme()) {
        return Err("Use an http or https instance URL".into());
    }
    if let Some(existing) = app.get_webview_window("client") {
        existing
            .navigate(parsed)
            .map_err(|error| error.to_string())?;
        return existing.set_focus().map_err(|error| error.to_string());
    }
    WebviewWindowBuilder::new(&app, "client", WebviewUrl::External(parsed))
        .title("Flight Finder")
        .inner_size(1180.0, 820.0)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn open_in_browser(url: &str) -> Result<(), String> {
    let spawned = if cfg!(target_os = "macos") {
        Command::new("open").arg(url).spawn()
    } else if cfg!(windows) {
        command("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn()
    } else {
        Command::new("xdg-open").arg(url).spawn()
    };
    spawned.map(|_| ()).map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(Tunnel::default()))
        .invoke_handler(tauri::generate_handler![
            docker_available,
            installed,
            connection,
            install_stack,
            start_stack,
            stop_stack,
            restart_stack,
            set_reach,
            is_healthy,
            open_app,
            lan_url,
            start_tunnel,
            stop_tunnel,
            save_server,
            load_server,
            open_client
        ])
        .build(tauri::generate_context!())
        .expect("error while building Flight Finder")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Ok(mut tunnel) = app.state::<Mutex<Tunnel>>().lock() {
                    let _ = tunnel.stop();
                }
            }
        });
}
