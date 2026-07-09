//! Deployment pipeline: clone → build → serve → health check → tunnel.

use std::path::PathBuf;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::sleep;
use tracing::info;

use crate::config::Config;
use crate::detect;
use crate::log::{drain_serve_logs_to_ws, emit_done, emit_log, run_cmd_streaming, run_shell_streaming, LogLine, WsStream};
use crate::protocol::{DeployStatus, LogStream};

#[derive(Debug)]
pub(crate) struct DeployParams {
	pub deployment_id: String,
	pub repo_url: String,
	pub ref_: String,
	pub build_command: Option<String>,
	pub serve_command: Option<String>,
	pub port: Option<u16>,
	pub hostname: Option<String>,
	pub public_url: Option<String>,
	pub tunnel_token: Option<String>,
	// tunnel_id is accepted from the worker for protocol completeness
	// (the worker always sends it alongside tunnel_token) but isn't
	// used by the agent — we resolve the tunnel by token via
	// `cloudflared tunnel run`. Keep the field so the canonical-JSON
	// HMAC payload signature on the worker side still matches.
	#[allow(dead_code)]
	pub tunnel_id: Option<String>,
	pub build_dir: PathBuf,
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_deploy(
	deployment_id: String,
	repo_url: String,
	ref_: String,
	build_command: Option<String>,
	serve_command: Option<String>,
	port: Option<u16>,
	hostname: Option<String>,
	public_url: Option<String>,
	tunnel_token: Option<String>,
	tunnel_id: Option<String>,
	cfg: Config,
	ws: &mut WsStream,
) {
    let mut line_no = 0u32;

    let params = DeployParams {
        deployment_id: deployment_id.clone(),
        repo_url: repo_url.clone(),
        ref_: ref_.clone(),
        build_command,
        serve_command,
        port,
        hostname,
        public_url,
        tunnel_token,
        tunnel_id,
        build_dir: std::env::temp_dir().join(format!("void-build-{}", &deployment_id)),
    };

    emit_log(&mut line_no, &deployment_id, ws, LogStream::Stdout, format!(
        "→ deploy {} ref={} from {}\n",
        params.deployment_id, params.ref_, params.repo_url
    ))
    .await;

    if params.build_dir.exists() {
        let _ = std::fs::remove_dir_all(&params.build_dir);
    }
    if let Err(e) = std::fs::create_dir_all(&params.build_dir) {
        emit_log(&mut line_no, &deployment_id, ws, LogStream::Stderr, format!("mkdir failed: {}\n", e)).await;
        emit_done(&deployment_id, ws, DeployStatus::Failed, None, None, Some(e.to_string())).await;
        return;
    }
    emit_log(
        &mut line_no,
        &deployment_id,
        ws,
        LogStream::Stdout,
        format!("→ build dir: {}\n", params.build_dir.display()),
    )
    .await;

    // git clone
    emit_log(
        &mut line_no,
        &deployment_id,
        ws,
        LogStream::Stdout,
        format!("→ git clone {} (depth 1)\n", params.repo_url),
    )
    .await;
    let exit = run_cmd_streaming(
        "git",
        &["clone", "--depth", "1", "--branch", &params.ref_, &params.repo_url, "."],
        &params.build_dir,
        &deployment_id,
        &mut line_no,
        ws,
    )
    .await;
    if exit != 0 {
        emit_log(
            &mut line_no,
            &deployment_id,
            ws,
            LogStream::Stderr,
            format!("git clone failed with exit code {}\n", exit),
        )
        .await;
        emit_done(
            &deployment_id,
            ws,
            DeployStatus::Failed,
            None,
            None,
            Some(format!("git clone failed (exit {})", exit)),
        )
        .await;
        return;
    }
    emit_log(&mut line_no, &deployment_id, ws, LogStream::Stdout, "→ ✓ clone complete\n".to_string()).await;

    // Auto-detect project type if build_command / serve_command not provided
    let port_in = params.port.unwrap_or(0);
    let (build_cmd, serve_cmd, port_eff) = if params.build_command.is_none() || params.serve_command.is_none() || port_in == 0 {
        let detected = detect::detect(&params.build_dir);
        emit_log(
            &mut line_no,
            &deployment_id,
            ws,
            LogStream::Stdout,
            format!("→ 🔍 auto-detected framework: {}\n", detected.framework),
        )
        .await;
        (
            params.build_command.clone().or(detected.build_command),
            params.serve_command.clone().or(detected.serve_command),
            if port_in == 0 { detected.port } else { port_in },
        )
    } else {
        (params.build_command.clone(), params.serve_command.clone(), port_in)
    };

    // build
    if let Some(cmd) = &build_cmd {
        emit_log(
            &mut line_no,
            &deployment_id,
            ws,
            LogStream::Stdout,
            format!("→ build: $ {}\n", cmd),
        )
        .await;
        let exit = run_shell_streaming(cmd, &params.build_dir, &deployment_id, &mut line_no, ws).await;
        if exit != 0 {
            emit_log(
                &mut line_no,
                &deployment_id,
                ws,
                LogStream::Stderr,
                format!("build failed with exit code {}\n", exit),
            )
            .await;
            emit_done(
                &deployment_id,
                ws,
                DeployStatus::Failed,
                None,
                None,
                Some(format!("build failed (exit {})", exit)),
            )
            .await;
            return;
        }
        emit_log(&mut line_no, &deployment_id, ws, LogStream::Stdout, "→ ✓ build complete\n".to_string()).await;
    } else {
        emit_log(
            &mut line_no,
            &deployment_id,
            ws,
            LogStream::Stdout,
            "→ no build_command, skipping\n".to_string(),
        )
        .await;
    }

    // serve
    if let Some(cmd) = &serve_cmd {
        let port = port_eff;
        let local_url = format!("http://127.0.0.1:{}", port);
        emit_log(
            &mut line_no,
            &deployment_id,
            ws,
            LogStream::Stdout,
            format!("→ serve: $ {} (port {})\n", cmd, port),
        )
        .await;

        let mut child = match Command::new("sh")
            .arg("-c")
            .arg(cmd)
            .current_dir(&params.build_dir)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                emit_log(
                    &mut line_no,
                    &deployment_id,
                    ws,
                    LogStream::Stderr,
                    format!("serve spawn failed: {}\n", e),
                )
                .await;
                emit_done(&deployment_id, ws, DeployStatus::Failed, None, None, Some(e.to_string())).await;
                return;
            }
        };

        // Drain stdout/stderr through a channel; the main loop pulls
        // from the channel and writes to ws. This keeps ws in the main
        // function scope, avoiding lifetime issues with &'static.
        let (tx, mut rx) = mpsc::channel::<LogLine>(64);
        if let Some(stdout) = child.stdout.take() {
            let txc = tx.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    if txc
                        .send(LogLine {
                            stream: LogStream::Stdout,
                            data: format!("{}\n", line),
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            let txc = tx.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    if txc
                        .send(LogLine {
                            stream: LogStream::Stderr,
                            data: format!("{}\n", line),
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            });
        }
        drop(tx);

        // Forward log lines to ws (in this function scope — no lifetime issues)
        drain_serve_logs_to_ws(&deployment_id, &mut line_no, &mut rx, ws).await;

        // Health check with 10s grace period. Poll every 500ms.
        // If we never see a 2xx, treat as failed start and kill the process.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let mut healthy = false;
        let mut last_err: Option<String> = None;
        while tokio::time::Instant::now() < deadline {
            match check_health(&local_url).await {
                Ok(()) => {
                    healthy = true;
                    break;
                }
                Err(e) => {
                    last_err = Some(e);
                    sleep(Duration::from_millis(500)).await;
                }
            }
        }

        if !healthy {
            emit_log(
                &mut line_no,
                &deployment_id,
                ws,
                LogStream::Stderr,
                format!(
                    "✗ health check FAILED: serve not responding on {} after 10s (last err: {})\n",
                    local_url,
                    last_err.unwrap_or_else(|| "none".to_string())
                ),
            )
            .await;
            emit_log(
                &mut line_no,
                &deployment_id,
                ws,
                LogStream::Stderr,
                "→ killing serve process and rolling back deploy\n".to_string(),
            )
            .await;
            let _ = child.kill().await;
            let _ = child.wait().await;
            emit_done(
                &deployment_id,
                ws,
                DeployStatus::Failed,
                None,
                Some(local_url.clone()),
                Some("health check failed: serve did not respond 2xx within 10s".to_string()),
            )
            .await;
            info!(deployment_id = %deployment_id, "✗ deploy failed (health check timeout)");
            return;
        }

        emit_log(
            &mut line_no,
            &deployment_id,
            ws,
            LogStream::Stdout,
            format!("→ ✓ serve alive on {}\n", local_url),
        )
        .await;

        let public_url = params
            .public_url
            .clone()
            .unwrap_or_else(|| {
                cfg.public_url_template
                    .replace("{port}", &port.to_string())
                    .replace("{deployment_id}", &deployment_id)
            });
        let local_url = format!("http://127.0.0.1:{}", port);

        // If we have a tunnel_token, ensure cloudflared is running so the
        // public URL is actually reachable.
        if let Some(token) = &params.tunnel_token {
            if let Some(host) = &params.hostname {
                emit_log(
                    &mut line_no,
                    &deployment_id,
                    ws,
                    LogStream::Stdout,
                    "→ ensuring cloudflared is running for tunnel...\n".to_string(),
                )
                .await;
                match crate::tunnel::ensure_cloudflared(
                    token,
                    host,
                    cfg.cloudflared_pid_file.as_deref().map(std::path::Path::new),
                )
                .await
                {
                    Ok(()) => {
                        emit_log(
                            &mut line_no,
                            &deployment_id,
                            ws,
                            LogStream::Stdout,
                            format!("→ ✓ cloudflared running, public URL active: {}\n", public_url),
                        )
                        .await;
                    }
                    Err(e) => {
                        emit_log(
                            &mut line_no,
                            &deployment_id,
                            ws,
                            LogStream::Stderr,
                            format!(
                                "→ cloudflared setup warning: {}. Install with `brew install cloudflared` (macOS) or `apt install cloudflared` (Linux). Public URL won't work until then.\n",
                                e
                            ),
                        )
                        .await;
                    }
                }
            }
        }

        emit_done(
            &deployment_id,
            ws,
            DeployStatus::Success,
            Some(public_url.clone()),
            Some(local_url.clone()),
            None,
        )
        .await;
        info!(
            deployment_id = %deployment_id,
            public_url,
            local_url,
            "✓ deploy complete (serve running)"
        );

        // Wait for the serve process to exit
        let _ = child.wait().await;
    } else {
        let public_url = format!("https://pr-{}.void.example.com", &deployment_id);
        emit_done(
            &deployment_id,
            ws,
            DeployStatus::Success,
            Some(public_url.clone()),
            None,
            None,
        )
        .await;
        info!(deployment_id = %deployment_id, url = %public_url, "✓ build complete (no serve)");
    }
}

async fn check_health(url: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| format!("client build: {}", e))?;
    match client.get(url).send().await {
        Ok(r) if r.status().is_success() || r.status().is_redirection() => Ok(()),
        Ok(r) => Err(format!("HTTP {}", r.status())),
        Err(e) => Err(format!("{}", e)),
    }
}
