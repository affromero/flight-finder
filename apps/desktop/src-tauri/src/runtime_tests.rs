use super::*;
use std::net::TcpListener;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;

static NEXT_DIR: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "flight-finder-desktop-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn persisted_port_and_binding_are_read_without_executing_config() {
    let fixture = Fixture::new();
    fs::write(
        fixture.0.join(".env"),
        "HOST_PORT=3017\nHOST_BIND_ADDRESS=127.0.0.1\nUNRELATED=$(exit 8)\n",
    )
    .unwrap();
    let config = connection(&fixture.0).unwrap();
    assert_eq!(config.port, 3017);
    assert!(config.local_only);
    fs::write(fixture.0.join(".env"), "HOST_PORT=0\n").unwrap();
    assert!(connection(&fixture.0).is_err());
}

#[test]
fn local_choice_updates_the_generated_binding_and_preserves_other_configuration() {
    let fixture = Fixture::new();
    fs::write(
        fixture.0.join("docker-compose.yml"),
        "services:\n  web:\n    ports:\n      - \"${HOST_PORT:-3003}:3003\"\n",
    )
    .unwrap();
    fs::write(
        fixture.0.join(".env"),
        "HOST_PORT=3019\nKEEP_VALUE=unchanged\n",
    )
    .unwrap();
    set_binding(&fixture.0, true).unwrap();
    assert!(connection(&fixture.0).unwrap().local_only);
    assert_eq!(connection(&fixture.0).unwrap().port, 3019);
    assert!(fs::read_to_string(fixture.0.join(".env"))
        .unwrap()
        .contains("KEEP_VALUE=unchanged"));
    assert!(fs::read_to_string(fixture.0.join("docker-compose.yml"))
        .unwrap()
        .contains("${HOST_BIND_ADDRESS:-0.0.0.0}"));
    set_binding(&fixture.0, false).unwrap();
    assert!(!connection(&fixture.0).unwrap().local_only);
}

#[test]
fn custom_port_mapping_is_left_unchanged() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("docker-compose.yml"), "custom: 4567:3003").unwrap();
    fs::write(fixture.0.join(".env"), "HOST_PORT=4567\n").unwrap();
    assert!(set_binding(&fixture.0, true)
        .unwrap_err()
        .contains("custom port"));
    assert_eq!(
        fs::read_to_string(fixture.0.join("docker-compose.yml")).unwrap(),
        "custom: 4567:3003"
    );
    assert_eq!(
        fs::read_to_string(fixture.0.join(".env")).unwrap(),
        "HOST_PORT=4567\n"
    );
}

#[test]
fn executable_search_preserves_paths_containing_spaces_and_native_separators() {
    let fixture = Fixture::new();
    let bin = fixture.0.join("Tools with spaces");
    fs::create_dir(&bin).unwrap();
    let executable = bin.join(if cfg!(windows) {
        "docker.EXE"
    } else {
        "docker"
    });
    fs::write(&executable, "fixture").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let path = std::env::join_paths([fixture.0.join("missing"), bin]).unwrap();
    let extensions = if cfg!(windows) {
        vec![String::new(), ".EXE".into()]
    } else {
        vec![String::new()]
    };
    assert_eq!(resolve_in("docker", &path, &extensions), Some(executable));
}

fn serve(responses: Vec<&'static str>) -> (u16, thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = thread::spawn(move || {
        responses
            .into_iter()
            .map(|body| {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                while !bytes.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    bytes.push(byte[0]);
                }
                write!(
                    stream,
                    "HTTP/1.0 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
                String::from_utf8_lossy(&bytes).into_owned()
            })
            .collect()
    });
    (port, handle)
}

#[test]
fn health_requires_a_healthy_database_and_flight_finder_version_response() {
    let (port, server) = serve(vec![
        r#"{"status":"ok","database":"connected","redis":"disabled"}"#,
        r#"{"ok":true,"data":{"current":"0.15.0","commit":"dev","updateAvailable":false}}"#,
    ]);
    assert!(is_healthy(port));
    let requests = server.join().unwrap();
    assert!(requests[0].starts_with("GET /api/health "));
    assert!(requests[1].starts_with("GET /api/version "));
    let (port, server) = serve(vec![
        r#"{"status":"ok","database":"error","redis":"connected"}"#,
    ]);
    assert!(!is_healthy(port));
    server.join().unwrap();
    let (port, server) = serve(vec!["An unrelated local server"]);
    assert!(!is_healthy(port));
    server.join().unwrap();
}

#[test]
fn identified_local_health_does_not_depend_on_remote_release_checks() {
    let (port, server) = serve(vec![
        r#"{"application":"flight-finder","status":"ok","database":"connected","redis":"disabled"}"#,
    ]);
    assert!(is_healthy(port));
    assert_eq!(server.join().unwrap().len(), 1);
    let (port, server) = serve(vec![
        r#"{"application":"another-app","status":"ok","database":"connected","redis":"disabled"}"#,
    ]);
    assert!(!is_healthy(port));
    server.join().unwrap();
}

#[test]
fn tunnel_url_ignores_documentation_links_before_the_assigned_address() {
    assert_eq!(tunnel_url("See https://developers.cloudflare.com/docs\n | https://test-tunnel.trycloudflare.com |"), Some("https://test-tunnel.trycloudflare.com/".into()));
    assert!(tunnel_url("https://trycloudflare.com.evil.test").is_none());
}

#[cfg(unix)]
fn shell_fixture(dir: &Path, name: &str, script: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(name);
    let mut file = fs::File::create(&path).unwrap();
    file.write_all(format!("#!/bin/sh\n{script}\n").as_bytes())
        .unwrap();
    file.sync_all().unwrap();
    drop(file);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

#[cfg(unix)]
#[test]
fn compose_passes_overrides_and_reports_container_failure() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join(".env"), "EXPRESSVPN_CODE=fixture\n").unwrap();
    fs::write(fixture.0.join("docker-compose.override.yml"), "").unwrap();
    fs::write(fixture.0.join("docker-compose.vpn.yml"), "").unwrap();
    let program = shell_fixture(&fixture.0, "compose", "printf '%s\\n' \"$@\"");
    let compose = Compose {
        runtime: program.clone(),
        program,
        prefix: vec![],
    };
    let args = compose
        .run(&fixture.0, &["up", "-d", "--force-recreate"])
        .unwrap();
    assert_eq!(
        args.lines().collect::<Vec<_>>(),
        [
            "-f",
            "docker-compose.yml",
            "-f",
            "docker-compose.override.yml",
            "-f",
            "docker-compose.vpn.yml",
            "up",
            "-d",
            "--force-recreate"
        ]
    );
    let compose = Compose {
        runtime: PathBuf::from("unused-runtime"),
        program: shell_fixture(
            &fixture.0,
            "broken",
            "echo 'daemon unavailable' >&2; exit 7",
        ),
        prefix: vec!["compose".into()],
    };
    assert!(compose
        .run(&fixture.0, &["up", "-d"])
        .unwrap_err()
        .contains("daemon unavailable"));
}

#[cfg(unix)]
#[test]
fn access_preparation_stops_web_and_finishes_before_serving() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join(".env"), "").unwrap();
    let log = fixture.0.join("compose.log");
    let program = shell_fixture(
        &fixture.0,
        "compose",
        &format!(
            "printf '%s ' \"$@\" >> '{}'; printf '\\n' >> '{}'",
            log.display(),
            log.display()
        ),
    );
    let compose = Compose {
        runtime: program.clone(),
        program,
        prefix: vec![],
    };

    prepare_access(&compose, &fixture.0).unwrap();
    compose
        .run(&fixture.0, &["up", "-d", "--force-recreate"])
        .unwrap();

    let calls = fs::read_to_string(log).unwrap();
    assert_eq!(
        calls.lines().collect::<Vec<_>>(),
        [
            "-f docker-compose.yml stop web ",
            "-f docker-compose.yml up -d --no-recreate db redis ",
            "-f docker-compose.yml run --rm --no-deps -e SIDEDOOR_PREPARE_ONLY=true web ",
            "-f docker-compose.yml up -d --force-recreate ",
        ]
    );
}

#[cfg(unix)]
#[test]
fn native_and_standalone_compose_runtimes_both_start_the_installed_stack() {
    for runtime in ["docker", "podman"] {
        for standalone in [false, true] {
            let fixture = Fixture::new();
            let version_code = if standalone { 1 } else { 0 };
            shell_fixture(&fixture.0, runtime, &format!("if [ \"$1 $2\" = 'compose version' ]; then exit {version_code}; fi\nprintf '%s\\n' \"$@\""));
            if standalone {
                shell_fixture(
                    &fixture.0,
                    &format!("{runtime}-compose"),
                    "if [ \"$1\" = version ]; then exit 0; fi\nprintf '%s\\n' \"$@\"",
                );
            }
            let paths = std::env::join_paths([&fixture.0]).unwrap();
            let compose =
                Compose::detect_using(|name| resolve_in(name, &paths, &[String::new()])).unwrap();
            let args = compose.run(&fixture.0, &["up", "-d"]).unwrap();
            let expected = if standalone {
                "-f\ndocker-compose.yml\nup\n-d\n"
            } else {
                "compose\n-f\ndocker-compose.yml\nup\n-d\n"
            };
            assert_eq!(args, expected);
        }
    }
}

#[cfg(unix)]
#[test]
fn stopping_an_owned_tunnel_leaves_unrelated_processes_running() {
    let mut unrelated = Command::new("sleep").arg("30").spawn().unwrap();
    let child = Command::new("sleep").arg("30").spawn().unwrap();
    let mut tunnel = Tunnel { child: Some(child) };
    tunnel.stop().unwrap();
    assert!(tunnel.child.is_none());
    let unrelated_running = unrelated.try_wait().unwrap().is_none();
    unrelated.kill().unwrap();
    unrelated.wait().unwrap();
    assert!(unrelated_running);
}

#[cfg(unix)]
#[test]
fn a_failed_installer_download_cannot_report_success() {
    let result = Command::new("bash")
        .args([
            "-o",
            "pipefail",
            "-c",
            &format!("curl() {{ return 22; }}; {INSTALL_SCRIPT}"),
        ])
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(22));
    assert!(checked(result).is_err());
}

#[cfg(unix)]
#[test]
fn local_only_verification_checks_all_published_bindings_from_the_container_runtime() {
    let fixture = Fixture::new();
    fs::write(
        fixture.0.join(".env"),
        "HOST_PORT=3017\nHOST_BIND_ADDRESS=127.0.0.1\n",
    )
    .unwrap();
    let runtime = shell_fixture(
        &fixture.0,
        "runtime",
        r#"printf '%s' '{"3003/tcp":[{"HostIp":"127.0.0.1","HostPort":"3017"},{"HostIp":"0.0.0.0","HostPort":"3018"}]}'"#,
    );
    let compose = Compose {
        program: shell_fixture(&fixture.0, "compose", "echo fixture-container"),
        runtime: runtime.clone(),
        prefix: vec![],
    };
    assert!(verify_binding(&compose, &fixture.0, true)
        .unwrap_err()
        .contains("does not match"));
    shell_fixture(
        &fixture.0,
        "runtime",
        r#"printf '%s' '{"3003/tcp":[{"HostIp":"127.0.0.1","HostPort":"3017"}]}'"#,
    );
    assert!(verify_binding(&compose, &fixture.0, true).is_ok());
    assert!(verify_binding(&compose, &fixture.0, false).is_err());
}
