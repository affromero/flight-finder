use serde::Serialize;
use serde_json::Value;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output};
use std::time::Duration;

pub fn home_dir() -> Result<PathBuf, String> {
    let home = if cfg!(windows) {
        std::env::var_os("USERPROFILE")
    } else {
        std::env::var_os("HOME")
    };
    home.filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or("Cannot locate your home directory".into())
}

pub fn install_dir() -> Result<PathBuf, String> {
    match std::env::var_os("FLIGHT_FINDER_DIR").filter(|value| !value.is_empty()) {
        Some(path) => Ok(PathBuf::from(path)),
        None => Ok(home_dir()?.join(".flight-finder")),
    }
}

pub fn augmented_path() -> OsString {
    let mut paths: Vec<PathBuf> =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
    if cfg!(windows) {
        for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(base) = std::env::var_os(key) {
                for suffix in [
                    "Git/bin",
                    "Git/usr/bin",
                    "Programs/Git/bin",
                    "Docker/Docker/resources/bin",
                    "RedHat/Podman",
                ] {
                    paths.push(PathBuf::from(&base).join(suffix));
                }
            }
        }
    } else {
        paths.extend(
            [
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/bin",
                "/bin",
                "/usr/sbin",
                "/sbin",
            ]
            .map(PathBuf::from),
        );
    }
    if let Ok(home) = home_dir() {
        paths.push(home.join(".docker/bin"));
        paths.push(home.join(".rd/bin"));
    }
    std::env::join_paths(paths).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

fn resolve_in(name: &str, paths: &OsStr, extensions: &[String]) -> Option<PathBuf> {
    for dir in std::env::split_paths(paths) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for extension in extensions {
            let candidate = dir.join(format!("{name}{extension}"));
            if !candidate.is_file() {
                continue;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if fs::metadata(&candidate).ok()?.permissions().mode() & 0o111 == 0 {
                    continue;
                }
            }
            return Some(candidate);
        }
    }
    None
}

pub fn which(name: &str) -> Option<PathBuf> {
    let mut extensions = vec![String::new()];
    if cfg!(windows) {
        extensions.extend(
            std::env::var("PATHEXT")
                .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
                .split(';')
                .map(String::from),
        );
    }
    resolve_in(name, &augmented_path(), &extensions)
}

pub fn command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    command.env("PATH", augmented_path());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

pub fn checked(output: Output) -> Result<String, String> {
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    Err(format!(
        "Command failed ({}): {}",
        output.status,
        if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        }
    ))
}

pub struct Compose {
    program: PathBuf,
    runtime: PathBuf,
    prefix: Vec<String>,
}

impl Compose {
    pub fn detect() -> Result<Self, String> {
        Self::detect_using(which)
    }

    fn detect_using(find: impl Fn(&str) -> Option<PathBuf>) -> Result<Self, String> {
        for runtime in ["docker", "podman"] {
            let Some(program) = find(runtime) else {
                continue;
            };
            if command(&program)
                .args(["compose", "version"])
                .output()
                .is_ok_and(|output| output.status.success())
            {
                return Ok(Self {
                    runtime: program.clone(),
                    program,
                    prefix: vec!["compose".into()],
                });
            }
            if let Some(standalone) = find(&format!("{runtime}-compose")) {
                if command(&standalone)
                    .arg("version")
                    .output()
                    .is_ok_and(|output| output.status.success())
                {
                    return Ok(Self {
                        runtime: program,
                        program: standalone,
                        prefix: vec![],
                    });
                }
            }
        }
        Err("Install Docker Desktop with Compose, or Podman with podman-compose, and start the container runtime.".into())
    }

    pub fn run(&self, dir: &Path, args: &[&str]) -> Result<String, String> {
        let mut cmd = command(&self.program);
        cmd.args(&self.prefix)
            .current_dir(dir)
            .args(["-f", "docker-compose.yml"]);
        if dir.join("docker-compose.override.yml").is_file() {
            cmd.args(["-f", "docker-compose.override.yml"]);
        }
        let config = fs::read_to_string(dir.join(".env")).unwrap_or_default();
        if dir.join("docker-compose.vpn.yml").is_file()
            && config_value(&config, "EXPRESSVPN_CODE").is_some_and(|value| !value.is_empty())
        {
            cmd.args(["-f", "docker-compose.vpn.yml"]);
        }
        checked(cmd.args(args).output().map_err(|error| error.to_string())?)
    }
}

pub fn bootstrap() -> Result<String, String> {
    let bash = if cfg!(windows) {
        std::env::split_paths(&augmented_path()).filter(|path| path.to_string_lossy().replace('\\', "/").to_ascii_lowercase().contains("/git/"))
            .map(|path| path.join("bash.exe")).find(|path| path.is_file())
    } else { which("bash") }.ok_or(if cfg!(windows) {
        "Install Git for Windows (including Git Bash), then reopen Flight Finder. Docker Desktop or Podman with Compose is also required."
    } else { "Bash is required to run the Flight Finder installer." })?;
    // Git Bash translates Windows paths from HOME and FLIGHT_FINDER_DIR. Set
    // both explicitly so its home agrees with the native launcher's directory.
    let mut cmd = command(bash);
    cmd.env("HOME", home_dir()?.to_string_lossy().replace('\\', "/"))
        .env(
            "FLIGHT_FINDER_DIR",
            install_dir()?.to_string_lossy().replace('\\', "/"),
        )
        .env("FLIGHT_FINDER_YES", "1")
        .env("FLIGHT_FINDER_OPEN_BROWSER", "0")
        .env("FLIGHT_FINDER_BIND_ADDRESS", "127.0.0.1");
    checked(
        cmd.args(["-o", "pipefail", "-c", INSTALL_SCRIPT])
            .output()
            .map_err(|error| error.to_string())?,
    )
}

const INSTALL_SCRIPT: &str = "curl --fail --silent --show-error --location --connect-timeout 15 --max-time 60 https://flight-finder.org/install.sh | bash";

fn config_value<'a>(config: &'a str, key: &str) -> Option<&'a str> {
    config
        .lines()
        .filter_map(|line| line.trim().split_once('='))
        .filter(|(name, _)| name.trim() == key)
        .map(|(_, value)| value.trim().trim_matches(['\'', '"']))
        .last()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub port: u16,
    pub local_only: bool,
}

pub fn connection(dir: &Path) -> Result<Connection, String> {
    let config = match fs::read_to_string(dir.join(".env")) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.to_string()),
    };
    let port = config_value(&config, "HOST_PORT")
        .unwrap_or("3003")
        .parse::<u16>()
        .ok()
        .filter(|port| *port > 0)
        .ok_or("HOST_PORT must be between 1 and 65535")?;
    let binding = config_value(&config, "HOST_BIND_ADDRESS").unwrap_or("0.0.0.0");
    if !["127.0.0.1", "0.0.0.0"].contains(&binding) {
        return Err("HOST_BIND_ADDRESS must be 127.0.0.1 or 0.0.0.0".into());
    }
    Ok(Connection {
        port,
        local_only: binding == "127.0.0.1",
    })
}

pub fn set_binding(dir: &Path, local_only: bool) -> Result<(), String> {
    let path = dir.join("docker-compose.yml");
    let original = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let old = "\"${HOST_PORT:-3003}:3003\"";
    let current = "\"${HOST_BIND_ADDRESS:-0.0.0.0}:${HOST_PORT:-3003}:3003\"";
    if !original.contains(old) && !original.contains(current) {
        return Err("This install has custom port mappings. Update its web binding manually before changing network access.".into());
    }
    // A custom override can publish additional ports, so its effective mapping
    // is verified after recreation before the UI claims local-only access.
    let updated = original.replace(old, current);
    let config_path = dir.join(".env");
    let config = fs::read_to_string(&config_path).map_err(|error| error.to_string())?;
    let mut lines: Vec<String> = config
        .lines()
        .filter(|line| {
            line.trim()
                .split_once('=')
                .map_or(true, |(key, _)| key.trim() != "HOST_BIND_ADDRESS")
        })
        .map(String::from)
        .collect();
    lines.push(format!(
        "HOST_BIND_ADDRESS={}",
        if local_only { "127.0.0.1" } else { "0.0.0.0" }
    ));
    fs::write(&path, updated).map_err(|error| error.to_string())?;
    fs::write(config_path, format!("{}\n", lines.join("\n"))).map_err(|error| error.to_string())
}

pub fn verify_binding(compose: &Compose, dir: &Path, local_only: bool) -> Result<(), String> {
    let output = compose.run(dir, &["ps", "-q", "web"])?;
    let port = connection(dir)?.port.to_string();
    let mut bindings = Vec::new();
    for id in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if id.len() > 128
            || !id.chars().all(|character| {
                character.is_ascii_alphanumeric() || character == '-' || character == '_'
            })
        {
            return Err("Container identity could not be verified".into());
        }
        let result = checked(
            command(&compose.runtime)
                .args(["inspect", id, "--format", "{{json .NetworkSettings.Ports}}"])
                .output()
                .map_err(|error| error.to_string())?,
        )?;
        let ports: Value = serde_json::from_str(&result)
            .map_err(|_| "Container port bindings could not be verified")?;
        let entries = ports["3003/tcp"]
            .as_array()
            .ok_or("The running container has no published web port")?;
        for entry in entries {
            let ip = entry["HostIp"]
                .as_str()
                .ok_or("Invalid published web address")?;
            let host_port = entry["HostPort"]
                .as_str()
                .ok_or("Invalid published web port")?;
            bindings.push((ip.to_owned(), host_port.to_owned()));
        }
    }
    let binding_matches = if local_only {
        bindings.iter().all(|(ip, _)| ip == "127.0.0.1")
    } else {
        bindings
            .iter()
            .any(|(ip, _)| ip == "0.0.0.0" || ip == "::" || ip.is_empty())
    };
    if bindings.is_empty()
        || bindings.iter().any(|(_, host_port)| *host_port != port)
        || !binding_matches
    {
        return Err("The running web port does not match the selected network access. Check your Compose overrides.".into());
    }
    Ok(())
}

fn http_json(port: u16, path: &str) -> Result<Value, String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(
            format!("GET {path} HTTP/1.0\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    stream
        .take(65_537)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > 65_536 {
        return Err("Health response is too large".into());
    }
    let text = String::from_utf8(bytes).map_err(|error| error.to_string())?;
    let (headers, body) = text
        .split_once("\r\n\r\n")
        .ok_or("Invalid HTTP health response")?;
    if !headers
        .lines()
        .next()
        .is_some_and(|line| line.split_whitespace().nth(1) == Some("200"))
    {
        return Err("Flight Finder is not healthy".into());
    }
    serde_json::from_str(body).map_err(|error| error.to_string())
}

pub fn is_healthy(port: u16) -> bool {
    let Ok(health) = http_json(port, "/api/health") else {
        return false;
    };
    if health["status"] != "ok"
        || health["database"] != "connected"
        || !matches!(health["redis"].as_str(), Some("connected" | "disabled"))
    {
        return false;
    }
    if let Some(application) = health.get("application") {
        return application == "flight-finder";
    }
    // Older instances have no identity field. Their version check remains
    // bounded and is only needed until they have been updated.
    let Ok(version) = http_json(port, "/api/version") else {
        return false;
    };
    version["ok"] == true
        && version["data"]["current"]
            .as_str()
            .is_some_and(|value| value.split('.').count() == 3)
        && version["data"]["commit"].is_string()
        && version["data"]["updateAvailable"].is_boolean()
}

#[derive(Default)]
pub struct Tunnel {
    pub child: Option<Child>,
}

impl Tunnel {
    pub fn stop(&mut self) -> Result<(), String> {
        let Some(child) = self.child.as_mut() else {
            return Ok(());
        };
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            child.kill().map_err(|error| error.to_string())?;
        }
        child.wait().map_err(|error| error.to_string())?;
        self.child = None;
        Ok(())
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

pub fn tunnel_url(log: &str) -> Option<String> {
    log.split_whitespace().find_map(|word| {
        let value = word.trim_matches('|');
        let url = tauri::Url::parse(value).ok()?;
        let host = url.host_str()?;
        (url.scheme() == "https"
            && host.ends_with(".trycloudflare.com")
            && host != ".trycloudflare.com")
            .then(|| url.to_string())
    })
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
