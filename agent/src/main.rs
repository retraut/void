//! void-agent main loop
//!
//! Lifecycle:
//! 1. Load config + identity
//! 2. Open WebSocket to Worker /cell/:server_id
//! 3. Send `register` (with public key + setup_token)
//! 4. Loop: send heartbeat every 30s, receive `deploy` commands, run them, stream logs
//! 5. Reconnect with exponential backoff on disconnect

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::{interval, sleep};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Message};
use tracing::{debug, error, info, warn};

mod config;
mod keys;

use config::Config;
use keys::Identity;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AgentOut {
    Register {
        server_id: String,
        public_key: String,
        setup_token: String,
    },
    Heartbeat {
        timestamp: u64,
    },
    Log {
        deployment_id: String,
        stream: String,
        data: String,
        line: u32,
    },
    DeployDone {
        deployment_id: String,
        status: String,
        url: Option<String>,
        local_url: Option<String>,
        error: Option<String>,
    },
    Ready {
        timestamp: u64,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(dead_code)]
enum AgentIn {
    Registered {},
    Ping {},
    Deploy {
        deployment_id: String,
        repo_url: String,
        #[serde(default = "default_ref")]
        ref_: String,
        env: Option<serde_json::Value>,
        build_command: Option<String>,
        serve_command: Option<String>,
        port: Option<u16>,
    },
    Shutdown {},
}

fn default_ref() -> String {
    "main".to_string()
}

#[derive(Debug, Clone)]
struct LogLine {
    stream: String,
    data: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cfg = Config::load().context("loading config")?;
    let state_dir = cfg.state_dir();
    let identity = Arc::new(Identity::load_or_create(&state_dir).context("loading identity")?);

    info!(
        server_id = %cfg.server_id,
        public_key = %identity.public_key_b64(),
        api_base = %cfg.api_base,
        state_dir = ?state_dir,
        "void-agent starting"
    );

    let mut backoff_ms = 1_000u64;
    loop {
        match run_session(&cfg, &identity).await {
            Ok(_) => {
                info!("session ended cleanly, reconnecting");
                backoff_ms = 1_000;
            }
            Err(e) => {
                error!(error = %e, "session errored, backing off {}ms", backoff_ms);
                sleep(Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(60_000);
            }
        }
    }
}

type WsStream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn run_session(cfg: &Config, identity: &Arc<Identity>) -> Result<()> {
    let ws_url = format!("{}/cell/{}", cfg.api_base.replace("http", "ws"), cfg.server_id);
    info!(url = %ws_url, "connecting");

    let mut req = ws_url.into_client_request()?;
    req.headers_mut().insert(
        "X-Void-Pubkey",
        HeaderValue::from_str(&identity.public_key_b64())?,
    );

    let (mut ws, _resp) = tokio_tungstenite::connect_async(req)
        .await
        .context("WebSocket connect failed")?;

    info!("connected, sending register");

    let register = AgentOut::Register {
        server_id: cfg.server_id.clone(),
        public_key: identity.public_key_b64(),
        setup_token: cfg.setup_token.clone(),
    };
    ws.send(Message::Text(serde_json::to_string(&register)?))
        .await
        .context("sending register")?;

    let mut heartbeat = interval(Duration::from_secs(30));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                let hb = AgentOut::Heartbeat { timestamp: now_ts() };
                if let Err(e) = ws.send(Message::Text(serde_json::to_string(&hb)?)).await {
                    warn!(error = %e, "heartbeat send failed");
                    return Err(e.into());
                }
                debug!("heartbeat sent");
            }
            msg = ws.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        handle_incoming(&text, cfg, identity, &mut ws).await?;
                    }
                    Some(Ok(Message::Ping(p))) => {
                        ws.send(Message::Pong(p)).await.ok();
                    }
                    Some(Ok(Message::Close(c))) => {
                        info!(code = ?c, "server closed connection");
                        return Ok(());
                    }
                    Some(Err(e)) => {
                        error!(error = %e, "WS error");
                        return Err(e.into());
                    }
                    None => {
                        warn!("WS stream ended");
                        return Ok(());
                    }
                    _ => {}
                }
            }
        }
    }
}

async fn handle_incoming(
    text: &str,
    cfg: &Config,
    _identity: &Arc<Identity>,
    ws: &mut WsStream,
) -> Result<()> {
    let parsed: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            warn!(error = %e, raw = %text, "invalid JSON from server");
            return Ok(());
        }
    };

    let msg_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
    info!(msg_type = %msg_type, "← server");

    match msg_type {
        "registered" => {
            info!("✓ registered with control plane");
        }
        "ping" => {
            let ready = AgentOut::Ready { timestamp: now_ts() };
            ws.send(Message::Text(serde_json::to_string(&ready)?)).await.ok();
        }
        "deploy" => {
            let deployment_id = parsed
                .get("deployment_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let repo_url = parsed
                .get("repo_url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let ref_ = parsed
                .get("ref")
                .and_then(|v| v.as_str())
                .unwrap_or("main")
                .to_string();
            let build_command = parsed
                .get("build_command")
                .and_then(|v| v.as_str())
                .map(String::from);
            let serve_command = parsed
                .get("serve_command")
                .and_then(|v| v.as_str())
                .map(String::from);
            let port = parsed
                .get("port")
                .and_then(|v| v.as_u64())
                .map(|n| n as u16);

            info!(deployment_id = %deployment_id, repo = %repo_url, ref_ = %ref_, "deploy requested");
            run_deploy(
                deployment_id,
                repo_url,
                ref_,
                build_command,
                serve_command,
                port,
                cfg.clone(),
                ws,
            )
            .await;
        }
        "shutdown" => {
            info!("shutdown requested, exiting");
            std::process::exit(0);
        }
        _ => {
            debug!(raw = %text, "unhandled server message");
        }
    }

    Ok(())
}

#[derive(Debug)]
struct DeployParams {
    deployment_id: String,
    repo_url: String,
    ref_: String,
    build_command: Option<String>,
    serve_command: Option<String>,
    port: Option<u16>,
    build_dir: PathBuf,
}

async fn run_deploy(
    deployment_id: String,
    repo_url: String,
    ref_: String,
    build_command: Option<String>,
    serve_command: Option<String>,
    port: Option<u16>,
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
        build_dir: std::env::temp_dir().join(format!("void-build-{}", &deployment_id)),
    };

    emit_log(&mut line_no, &deployment_id, ws, "stdout", format!(
        "→ deploy {} ref={} from {}\n",
        params.deployment_id, params.ref_, params.repo_url
    ))
    .await;

    if params.build_dir.exists() {
        let _ = std::fs::remove_dir_all(&params.build_dir);
    }
    if let Err(e) = std::fs::create_dir_all(&params.build_dir) {
        emit_log(&mut line_no, &deployment_id, ws, "stderr", format!("mkdir failed: {}\n", e)).await;
        emit_done(&deployment_id, ws, "failed", None, None, Some(e.to_string())).await;
        return;
    }
    emit_log(
        &mut line_no,
        &deployment_id,
        ws,
        "stdout",
        format!("→ build dir: {}\n", params.build_dir.display()),
    )
    .await;

    // git clone
    emit_log(
        &mut line_no,
        &deployment_id,
        ws,
        "stdout",
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
            "stderr",
            format!("git clone failed with exit code {}\n", exit),
        )
        .await;
        emit_done(
            &deployment_id,
            ws,
            "failed",
            None,
            None,
            Some(format!("git clone failed (exit {})", exit)),
        )
        .await;
        return;
    }
    emit_log(&mut line_no, &deployment_id, ws, "stdout", "→ ✓ clone complete\n".to_string()).await;

    // build
    if let Some(cmd) = &params.build_command {
        emit_log(
            &mut line_no,
            &deployment_id,
            ws,
            "stdout",
            format!("→ build: $ {}\n", cmd),
        )
        .await;
        let exit = run_shell_streaming(cmd, &params.build_dir, &deployment_id, &mut line_no, ws).await;
        if exit != 0 {
            emit_log(
                &mut line_no,
                &deployment_id,
                ws,
                "stderr",
                format!("build failed with exit code {}\n", exit),
            )
            .await;
            emit_done(
                &deployment_id,
                ws,
                "failed",
                None,
                None,
                Some(format!("build failed (exit {})", exit)),
            )
            .await;
            return;
        }
        emit_log(&mut line_no, &deployment_id, ws, "stdout", "→ ✓ build complete\n".to_string()).await;
    } else {
        emit_log(
            &mut line_no,
            &deployment_id,
            ws,
            "stdout",
            "→ no build_command, skipping\n".to_string(),
        )
        .await;
    }

    // serve
    if let Some(cmd) = &params.serve_command {
        let port = params.port.unwrap_or(3000);
        let local_url = format!("http://127.0.0.1:{}", port);
        emit_log(
            &mut line_no,
            &deployment_id,
            ws,
            "stdout",
            format!("→ serve: $ {} (port {})\n", cmd, port),
        )
        .await;

        let mut child = match Command::new("sh")
            .arg("-c")
            .arg(cmd)
            .current_dir(&params.build_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                emit_log(
                    &mut line_no,
                    &deployment_id,
                    ws,
                    "stderr",
                    format!("serve spawn failed: {}\n", e),
                )
                .await;
                emit_done(&deployment_id, ws, "failed", None, None, Some(e.to_string())).await;
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
                            stream: "stdout".into(),
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
                            stream: "stderr".into(),
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

        sleep(Duration::from_millis(1500)).await;

        let healthy = check_health(&local_url).await;
        if !healthy {
            emit_log(
                &mut line_no,
                &deployment_id,
                ws,
                "stderr",
                format!("warning: serve not responding on {} yet\n", local_url),
            )
            .await;
        } else {
            emit_log(
                &mut line_no,
                &deployment_id,
                ws,
                "stdout",
                format!("→ ✓ serve alive on {}\n", local_url),
            )
            .await;
        }

        let public_url = cfg
            .public_url_template
            .replace("{port}", &port.to_string())
            .replace("{deployment_id}", &deployment_id);
        emit_done(
            &deployment_id,
            ws,
            "success",
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
            "success",
            Some(public_url.clone()),
            None,
            None,
        )
        .await;
        info!(deployment_id = %deployment_id, url = %public_url, "✓ build complete (no serve)");
    }
}

/// Drains log lines from `rx` and writes them to `ws` as Log messages.
async fn drain_serve_logs_to_ws(
    deployment_id: &str,
    line_no: &mut u32,
    rx: &mut mpsc::Receiver<LogLine>,
    ws: &mut WsStream,
) {
    let drain_deadline = tokio::time::Instant::now() + Duration::from_secs(60 * 60);
    loop {
        tokio::select! {
            maybe = rx.recv() => {
                match maybe {
                    Some(line) => {
                        *line_no += 1;
                        let msg = AgentOut::Log {
                            deployment_id: deployment_id.to_string(),
                            stream: line.stream,
                            data: line.data,
                            line: *line_no,
                        };
                        let json = serde_json::to_string(&msg).unwrap();
                        if let Err(e) = ws.send(Message::Text(json)).await {
                            warn!(error = %e, "ws send failed, stopping forward");
                            break;
                        }
                    }
                    None => break,
                }
            }
            _ = tokio::time::sleep_until(drain_deadline) => {
                warn!("log forward timeout, giving up");
                break;
            }
        }
    }
}

async fn emit_log(
    line_no: &mut u32,
    deployment_id: &str,
    ws: &mut WsStream,
    stream: &str,
    data: String,
) {
    *line_no += 1;
    let msg = AgentOut::Log {
        deployment_id: deployment_id.to_string(),
        stream: stream.to_string(),
        data,
        line: *line_no,
    };
    let json = serde_json::to_string(&msg).unwrap();
    if let Err(e) = ws.send(Message::Text(json)).await {
        error!(error = %e, "failed to send log line");
    }
}

async fn emit_done(
    deployment_id: &str,
    ws: &mut WsStream,
    status: &str,
    url: Option<String>,
    local_url: Option<String>,
    error: Option<String>,
) {
    let msg = AgentOut::DeployDone {
        deployment_id: deployment_id.to_string(),
        status: status.to_string(),
        url,
        local_url,
        error,
    };
    let json = serde_json::to_string(&msg).unwrap();
    let _ = ws.send(Message::Text(json)).await;
}

async fn run_cmd_streaming(
    cmd: &str,
    args: &[&str],
    cwd: &std::path::Path,
    deployment_id: &str,
    line_no: &mut u32,
    ws: &mut WsStream,
) -> i32 {
    let mut child = match Command::new(cmd)
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            emit_log(line_no, deployment_id, ws, "stderr", format!("spawn {} failed: {}\n", cmd, e)).await;
            return -1;
        }
    };

    stream_child_to_ws(&mut child, deployment_id, line_no, ws).await;

    match child.wait().await {
        Ok(status) => status.code().unwrap_or(-1),
        Err(_) => -1,
    }
}

async fn run_shell_streaming(
    cmd: &str,
    cwd: &std::path::Path,
    deployment_id: &str,
    line_no: &mut u32,
    ws: &mut WsStream,
) -> i32 {
    let mut child = match Command::new("sh")
        .arg("-c")
        .arg(cmd)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            emit_log(line_no, deployment_id, ws, "stderr", format!("sh -c failed: {}\n", e)).await;
            return -1;
        }
    };

    stream_child_to_ws(&mut child, deployment_id, line_no, ws).await;

    match child.wait().await {
        Ok(status) => status.code().unwrap_or(-1),
        Err(_) => -1,
    }
}

/// Reads child stdout/stderr line-by-line and writes to ws as Log messages.
/// Uses a select! loop that polls child exit and line readers concurrently.
async fn stream_child_to_ws(
    child: &mut tokio::process::Child,
    deployment_id: &str,
    line_no: &mut u32,
    ws: &mut WsStream,
) {
    // Take stdout/stderr (we own the child &mut locally; we don't return them)
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let (tx, mut rx) = mpsc::channel::<LogLine>(64);

    if let Some(out) = stdout {
        let txc = tx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(out).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if txc
                    .send(LogLine {
                        stream: "stdout".into(),
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
    if let Some(err) = stderr {
        let txc = tx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(err).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if txc
                    .send(LogLine {
                        stream: "stderr".into(),
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

    // Drain channel until both readers close. We can hold ws here because
    // we're inside run_deploy which holds it; we don't move ws anywhere.
    // We give it a timeout equal to the process lifetime (parent calls
    // .wait() after this returns, so once stdout/stderr close, we exit).
    let drain_deadline = tokio::time::Instant::now() + Duration::from_secs(60 * 60);
    loop {
        tokio::select! {
            maybe = rx.recv() => {
                match maybe {
                    Some(line) => {
                        *line_no += 1;
                        let msg = AgentOut::Log {
                            deployment_id: deployment_id.to_string(),
                            stream: line.stream,
                            data: line.data,
                            line: *line_no,
                        };
                        let json = serde_json::to_string(&msg).unwrap();
                        if let Err(e) = ws.send(Message::Text(json)).await {
                            warn!(error = %e, "ws send failed, stopping forward");
                            break;
                        }
                    }
                    None => break, // both readers closed
                }
            }
            _ = tokio::time::sleep_until(drain_deadline) => {
                warn!("log forward timeout, giving up");
                break;
            }
        }
    }
}

async fn check_health(url: &str) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client.get(url).send().await {
        Ok(r) => r.status().is_success() || r.status().is_redirection(),
        Err(_) => false,
    }
}

fn now_ts() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
