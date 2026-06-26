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
use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::{interval, sleep};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Message};
use tracing::{debug, error, info, warn};

mod config;
mod detect;
mod keys;
mod protocol;

use config::Config;
use keys::Identity;
pub use protocol::{AgentOut, DeployStatus, LogStream, WorkerToAgent};

#[derive(Debug, Clone)]
struct LogLine {
    stream: LogStream,
    data: String,
}

#[tokio::main]
async fn main() -> Result<()> {
	let _ = rustls::crypto::ring::default_provider().install_default();

	// Logging format. Selected via LOG_FORMAT env var:
	//   text (default)  — human-readable, coloured when stderr is a TTY.
	//                     Best for local dev / `tail -f agent.log`.
	//   json            — newline-delimited JSON, one record per log
	//                     line on stderr. Best for log shippers
	//                     (Loki / Datadog / Vector / Fluent Bit).
	//   json-pretty     — indented JSON, one record per line. Best for
	//                     humans who want the structure of json but
	//                     don't want to read minified output.
	// The level is always RUST_LOG (env-filter compatible).
	use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, fmt};
	let log_format = std::env::var("LOG_FORMAT").unwrap_or_else(|_| "text".to_string());
	let env_filter = EnvFilter::try_from_default_env()
		.unwrap_or_else(|_| EnvFilter::new("info"));

	let json_layer = fmt::layer()
		.json()
		.flatten_event(true)
		.with_current_span(false)
		.with_span_list(false)
		.with_target(true)
		.with_file(false)
		.with_line_number(false)
		.with_writer(std::io::stderr);

	match log_format.as_str() {
		"json" => {
			tracing_subscriber::registry().with(env_filter).with(json_layer).init();
		}
		"json-pretty" => {
			tracing_subscriber::registry()
				.with(env_filter)
				.with(json_layer.pretty())
				.init();
		}
		_ => {
			// "text" or anything else — human-readable, stderr.
			tracing_subscriber::registry()
				.with(env_filter)
				.with(fmt::layer().with_writer(std::io::stderr))
				.init();
		}
	}

	let cfg = Config::load().context("loading config")?;
	let state_dir = cfg.state_dir();
	let identity = Arc::new(Identity::load_or_create(&state_dir).context("loading identity")?);

	// Make sure the per-deployment log directory exists. Logs are
	// appended to JSONL files (one per deployment) so they survive a
	// WebSocket disconnect and can be tailed/inspected offline.
	// See emit_log() for the write path. We also stash the state
	// dir in VOID_STATE_DIR so the append_to_jsonl_log() helper
	// can find it without us having to plumb the PathBuf through
	// every function.
	let logs_dir = state_dir.join("logs");
	if let Err(e) = std::fs::create_dir_all(&logs_dir) {
		warn!(error = %e, dir = %logs_dir.display(), "could not create logs dir, per-deploy file logs will be skipped");
	}
	std::env::set_var("VOID_STATE_DIR", &state_dir);

	info!(
		server_id = %cfg.server_id,
		public_key = %identity.public_key_b64(),
		api_base = %cfg.api_base,
		state_dir = %state_dir.display(),
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

    // Load session_token from disk (if we have one from a previous successful register)
    let session_token_file = cfg.state_dir().join("session_token");
    let session_token = std::fs::read_to_string(&session_token_file)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let register = if let Some(token) = &session_token {
        info!("reconnecting with session_token");
        AgentOut::Register {
            server_id: cfg.server_id.clone(),
            public_key: identity.public_key_b64(),
            setup_token: None,
            session_token: Some(token.clone()),
        }
    } else {
        info!("first-time register with setup_token");
        AgentOut::Register {
            server_id: cfg.server_id.clone(),
            public_key: identity.public_key_b64(),
            setup_token: Some(cfg.setup_token.clone()),
            session_token: None,
        }
    };
    ws.send(Message::Text(serde_json::to_string(&register)?))
        .await
        .context("sending register")?;

    // Heartbeat is started AFTER the registered frame is received
    // (handled inside the message loop). Don't fire one immediately —
    // tokio's interval first tick is immediate and would race the register.
    let mut heartbeat: Option<tokio::time::Interval> = None;

    loop {
        tokio::select! {
            _ = async {
                match heartbeat.as_mut() {
                    Some(hb) => hb.tick().await,
                    None => std::future::pending().await,
                }
            } => {
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
                        let is_registered = handle_incoming(&text, cfg, identity, &mut ws).await?;
                        if is_registered && heartbeat.is_none() {
                            info!("starting heartbeat (30s interval)");
                            let mut hb = interval(Duration::from_secs(30));
                            hb.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                            // Skip the immediate first tick — already registered
                            hb.tick().await;
                            heartbeat = Some(hb);
                        }
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
) -> Result<bool> {
    // Parse the frame with serde — `deny_unknown_fields` on the Rust side
    // matches the Zod `.strict()` on the TS side. Either side rejects drift.
    let frame: WorkerToAgent = match serde_json::from_str(text) {
        Ok(f) => f,
        Err(e) => {
            warn!(error = %e, raw = %text, "invalid frame from server (protocol drift?)");
            let err = serde_json::to_string(&AgentOut::DeployDone {
                deployment_id: "".into(),
                status: protocol::DeployStatus::Failed,
                url: None,
                local_url: None,
                error: Some(format!("invalid frame: {}", e)),
            })
            .unwrap_or_else(|_| r#"{"type":"error","code":"bad_frame"}"#.to_string());
            let _ = ws.send(Message::Text(err)).await;
            return Ok(false);
        }
    };

    match frame {
        WorkerToAgent::Registered { session_token } => {
            info!("✓ registered with control plane");
            if let Some(token) = session_token {
                let token_path = cfg.state_dir().join("session_token");
                let _ = std::fs::create_dir_all(cfg.state_dir());
                let _ = std::fs::write(token_path, token);
                info!("session_token saved to disk");
            }
            return Ok(true);
        }
        WorkerToAgent::Ping {} => {
            let ready = AgentOut::Ready { timestamp: now_ts() };
            ws.send(Message::Text(serde_json::to_string(&ready)?)).await.ok();
        }
        WorkerToAgent::Deploy {
            deployment_id,
            repo_url,
            ref_,
            env: _env,
            build_command,
            serve_command,
            port,
            hostname,
            public_url,
            tunnel_token,
            tunnel_id,
            sig,
        } => {
            // CRITICAL: Verify HMAC signature if AGENT_SHARED_SECRET is set
            if let Some(secret) = &cfg.agent_shared_secret {
                let Some(sig_str) = &sig else {
                    warn!("deploy message has no signature but AGENT_SHARED_SECRET is set — rejecting");
                    let _ = ws
                        .send(Message::Text(
                            r#"{"type":"error","code":"missing_signature"}"#.to_string(),
                        ))
                        .await;
                    return Ok(false);
                };
                // Reconstruct the payload as the canonical JSON (without sig).
                // Use a typed struct so the field order matches the Worker's signing.
                #[derive(Serialize)]
                #[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
                struct DeployNoSig<'a> {
                    #[serde(rename = "type")]
                    ty: &'a str,
                    deployment_id: &'a str,
                    repo_url: &'a str,
                    #[serde(rename = "ref")]
                    ref_: &'a str,
                    env: &'a std::collections::BTreeMap<String, String>,
                    #[serde(skip_serializing_if = "Option::is_none")]
                    build_command: &'a Option<String>,
                    #[serde(skip_serializing_if = "Option::is_none")]
                    serve_command: &'a Option<String>,
                    port: u16,
                    #[serde(skip_serializing_if = "Option::is_none")]
                    hostname: &'a Option<String>,
                    #[serde(skip_serializing_if = "Option::is_none")]
                    public_url: &'a Option<String>,
                    #[serde(skip_serializing_if = "Option::is_none")]
                    tunnel_token: &'a Option<String>,
                    #[serde(skip_serializing_if = "Option::is_none")]
                    tunnel_id: &'a Option<String>,
                }
                let payload = DeployNoSig {
                    ty: "deploy",
                    deployment_id: &deployment_id,
                    repo_url: &repo_url,
                    ref_: &ref_,
                    env: &_env,
                    build_command: &build_command,
                    serve_command: &serve_command,
                    port,
                    hostname: &hostname,
                    public_url: &public_url,
                    tunnel_token: &tunnel_token,
                    tunnel_id: &tunnel_id,
                };
                let payload_str = serde_json::to_string(&payload).unwrap_or_default();
                let valid = verify_hmac_sha256(secret, &payload_str, sig_str);
                if !valid {
                    warn!("HMAC signature verification FAILED for deploy — rejecting");
                    let _ = ws
                        .send(Message::Text(
                            r#"{"type":"error","code":"invalid_signature"}"#.to_string(),
                        ))
                        .await;
                    return Ok(false);
                }
                info!("✓ deploy signature verified");
            }

            info!(deployment_id = %deployment_id, repo = %repo_url, ref_ = %ref_, "deploy requested");
            run_deploy(
                deployment_id,
                repo_url,
                ref_,
                build_command,
                serve_command,
                Some(port),
                hostname,
                public_url,
                tunnel_token,
                tunnel_id,
                cfg.clone(),
                ws,
            )
            .await;
        }
        WorkerToAgent::Shutdown {} => {
            info!("shutdown requested, exiting");
            std::process::exit(0);
        }
        WorkerToAgent::Error { code, message } => {
            warn!(code = %code, message = ?message, "← server error frame");
        }
    }

    Ok(false)
}

#[derive(Debug)]
struct DeployParams {
	deployment_id: String,
	repo_url: String,
	ref_: String,
	build_command: Option<String>,
	serve_command: Option<String>,
	port: Option<u16>,
	hostname: Option<String>,
	public_url: Option<String>,
	tunnel_token: Option<String>,
	// tunnel_id is accepted from the worker for protocol completeness
	// (the worker always sends it alongside tunnel_token) but isn't
	// used by the agent — we resolve the tunnel by token via
	// `cloudflared tunnel run`. Keep the field so the canonical-JSON
	// HMAC payload signature on the worker side still matches.
	#[allow(dead_code)]
	tunnel_id: Option<String>,
	build_dir: PathBuf,
}

async fn run_deploy(
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
                    format!("→ ensuring cloudflared is running for tunnel...\n"),
                )
                .await;
                match ensure_cloudflared(
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
	stream: LogStream,
	data: String,
) {
	*line_no += 1;
	let msg = AgentOut::Log {
		deployment_id: deployment_id.to_string(),
		stream,
		data: data.clone(),
		line: *line_no,
	};
	let json = serde_json::to_string(&msg).unwrap();
	if let Err(e) = ws.send(Message::Text(json)).await {
		error!(error = %e, "failed to send log line");
	}
	// Best-effort append to the per-deployment JSONL log file. We
	// do this AFTER the WS send so a slow disk never delays the
	// real-time stream. If the file write fails, the WS copy is
	// still the source of truth.
	append_to_jsonl_log(deployment_id, stream, *line_no, &data).await;
}

/// Append a single log line to the per-deployment JSONL file.
/// The file lives at $state_dir/logs/{deployment_id}.jsonl.
/// We open the file on every write (cheap for a few writes per
/// second, and the alternative is keeping an AsyncFile handle in
/// scope across the whole deploy function, which is a lifetime
/// nightmare). Writes are best-effort — a failure is logged at
/// debug level but doesn't break the deploy.
async fn append_to_jsonl_log(
	deployment_id: &str,
	stream: LogStream,
	line_no: u32,
	data: &str,
) {
	// The path is constructed from VOID_STATE_DIR (resolved at agent
	// start). We read it from env at call time to keep this fn
	// self-contained; if it's missing we silently skip the file write.
	let Some(state_dir) = std::env::var_os("VOID_STATE_DIR") else {
		return;
	};
	let path = std::path::PathBuf::from(state_dir)
		.join("logs")
		.join(format!("{}.jsonl", deployment_id));
	// Build the JSONL record (newline-delimited JSON). Same fields as
	// the WS frame, plus a top-level timestamp so the file is useful
	// offline without a separate index.
	let record = serde_json::json!({
		"ts": now_ts(),
		"deployment_id": deployment_id,
		"line": line_no,
		"stream": stream,
		"data": data,
	});
	// Strip the trailing \n in `data` if any — JSON encodes the full
	// line content as a single string, no need to duplicate.
	let record_str = match serde_json::to_string(&record) {
		Ok(s) => format!("{}\n", s),
		Err(_) => return,
	};
	// Best-effort append. We don't propagate the error — failing to
	// write a log file should never break a deploy.
	if let Ok(mut f) = tokio::fs::OpenOptions::new()
		.create(true)
		.append(true)
		.open(&path)
		.await
	{
		let _ = f.write_all(record_str.as_bytes()).await;
	}
}

async fn emit_done(
    deployment_id: &str,
    ws: &mut WsStream,
    status: DeployStatus,
    url: Option<String>,
    local_url: Option<String>,
    error: Option<String>,
) {
    let msg = AgentOut::DeployDone {
        deployment_id: deployment_id.to_string(),
        status,
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
            emit_log(line_no, deployment_id, ws, LogStream::Stderr, format!("spawn {} failed: {}\n", cmd, e)).await;
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
            emit_log(line_no, deployment_id, ws, LogStream::Stderr, format!("sh -c failed: {}\n", e)).await;
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
    if let Some(err) = stderr {
        let txc = tx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(err).lines();
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

fn now_ts() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// Ensure cloudflared is running for the given tunnel token. Idempotent:
/// - kills any previously tracked cloudflared instance (prevents orphan leak)
/// - if cloudflared is installed, start it in the background
/// - if cloudflared is not installed, return an error so the caller can log
/// - saves the new PID to a file for the next deploy to kill
async fn ensure_cloudflared(
    tunnel_token: &str,
    _hostname: &str,
    pid_file: Option<&std::path::Path>,
) -> Result<(), String> {
    // 1. check if cloudflared is on PATH
    let which = Command::new("which")
        .arg("cloudflared")
        .output()
        .await
        .map_err(|e| format!("which failed: {}", e))?;
    if !which.status.success() {
        return Err("cloudflared not found in PATH".to_string());
    }

    // 2. Kill any previously tracked cloudflared (prevents orphan leak on every deploy)
    if let Some(pid_path) = pid_file {
        if let Ok(pid_str) = std::fs::read_to_string(pid_path) {
            if let Ok(pid) = pid_str.trim().parse::<i32>() {
                // SIGTERM the old cloudflared, then clean up the pid file
                #[cfg(unix)]
                unsafe {
                    libc::kill(pid, libc::SIGTERM);
                }
                let _ = std::fs::remove_file(pid_path);
                tracing::info!(old_pid = pid, "killed previous cloudflared instance");
                // give it a moment to release the tunnel
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }

    // 3. start cloudflared as a background process
    // SECURITY: pass the token via TUNNEL_TOKEN env var, NOT as a CLI arg,
    // so it doesn't appear in `ps aux` output.
    let mut child = Command::new("cloudflared")
        .arg("tunnel")
        .arg("--no-autoupdate")
        .arg("run")
        .env("TUNNEL_TOKEN", tunnel_token)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false)
        .spawn()
        .map_err(|e| format!("spawn cloudflared failed: {}", e))?;

    let new_pid = child.id();

    // Save the new PID for next-time cleanup
    if let (Some(pid_path), Some(pid)) = (pid_file, new_pid) {
        if let Some(parent) = pid_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(pid_path, pid.to_string());
    }

    // capture initial output (timeout so we don't block forever)
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    if let Some(out) = stdout {
        let mut reader = BufReader::new(out).lines();
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            while let Ok(Some(line)) = reader.next_line().await {
                tracing::info!(target: "cloudflared", "{}", line);
            }
        })
        .await;
    }
    if let Some(err) = stderr {
        let mut reader = BufReader::new(err).lines();
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            while let Ok(Some(line)) = reader.next_line().await {
                tracing::warn!(target: "cloudflared", "{}", line);
            }
        })
        .await;
    }

    // Detach: don't wait on the child.
    tokio::spawn(async move {
        let _ = child.wait().await;
        tracing::info!("cloudflared process exited");
    });

    Ok(())
}

/// Verify HMAC-SHA256 signature of a deploy message.
/// Constant-time compare. Signature format: "v1.<hex>"
fn verify_hmac_sha256(secret: &str, payload: &str, signature: &str) -> bool {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let expected_hex = match signature.strip_prefix("v1.") {
        Some(h) => h,
        None => return false,
    };

    type HmacSha256 = Hmac<Sha256>;
    let mut mac = match HmacSha256::new_from_slice(secret.as_bytes()) {
        Ok(m) => m,
        Err(_) => return false,
    };
    mac.update(payload.as_bytes());
    let expected = mac.finalize().into_bytes();
    let expected_hex_str = hex::encode(expected);

    // Constant-time compare
    if expected_hex_str.len() != expected_hex.len() {
        return false;
    }
    let diff: u32 = expected_hex_str
        .bytes()
        .zip(expected_hex.bytes())
        .map(|(a, b)| (a ^ b) as u32)
        .sum();
    diff == 0
}
