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
use std::sync::Arc;
use std::time::Duration;
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
        error: Option<String>,
    },
    Ready {
        timestamp: u64,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AgentIn {
    Registered {},
    Ping {},
    Deploy {
        deployment_id: String,
        repo_url: String,
        #[serde(default = "default_ref")]
        ref_: String,
        env: Option<serde_json::Value>,
    },
    Shutdown {},
}

fn default_ref() -> String {
    "main".to_string()
}

#[tokio::main]
async fn main() -> Result<()> {
    // Install a default rustls crypto provider before any TLS connection.
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

            info!(deployment_id = %deployment_id, repo = %repo_url, ref_ = %ref_, "deploy requested");
            run_deploy(deployment_id, repo_url, ref_, cfg.clone(), ws).await;
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

async fn run_deploy(
    deployment_id: String,
    repo_url: String,
    ref_: String,
    cfg: Config,
    ws: &mut WsStream,
) {
    let mut line_no = 0u32;

    macro_rules! send_log {
        ($stream:expr, $data:expr) => {{
            line_no += 1;
            let msg = AgentOut::Log {
                deployment_id: deployment_id.clone(),
                stream: $stream.to_string(),
                data: $data,
                line: line_no,
            };
            let json = serde_json::to_string(&msg).unwrap();
            if let Err(e) = ws.send(Message::Text(json)).await {
                error!(error = %e, "failed to send log line");
            }
        }};
    }

    send_log!("stdout", format!("→ deploy {} ref={} from {}\n", deployment_id, ref_, repo_url));
    send_log!("stdout", format!("→ [stub] would git clone {}\n", repo_url));
    send_log!("stdout", "→ [stub] would run railpack build\n".to_string());
    send_log!("stdout", "→ [stub] would docker run\n".to_string());

    let success = if let Some(cmd) = &cfg.test_command {
        send_log!("stdout", format!("→ running test command: {}\n", cmd));
        match tokio::process::Command::new("sh")
            .arg("-c")
            .arg(cmd)
            .output()
            .await
        {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let stderr = String::from_utf8_lossy(&out.stderr);
                for line in stdout.lines() {
                    send_log!("stdout", format!("{}\n", line));
                }
                for line in stderr.lines() {
                    send_log!("stderr", format!("{}\n", line));
                }
                out.status.success()
            }
            Err(e) => {
                send_log!("stderr", format!("command failed: {}\n", e));
                let done = AgentOut::DeployDone {
                    deployment_id: deployment_id.clone(),
                    status: "failed".to_string(),
                    url: None,
                    error: Some(e.to_string()),
                };
                let json = serde_json::to_string(&done).unwrap();
                let _ = ws.send(Message::Text(json)).await;
                return;
            }
        }
    } else {
        sleep(Duration::from_millis(300)).await;
        send_log!("stdout", "→ [stub] build complete\n".to_string());
        send_log!("stdout", "→ [stub] container running\n".to_string());
        true
    };

    let url = format!("https://pr-{}.void.example.com", &deployment_id);
    let done = AgentOut::DeployDone {
        deployment_id: deployment_id.clone(),
        status: if success { "success" } else { "failed" }.to_string(),
        url: if success { Some(url.clone()) } else { None },
        error: None,
    };
    let json = serde_json::to_string(&done).unwrap();
    let _ = ws.send(Message::Text(json)).await;
    info!(deployment_id = %deployment_id, url = %url, success, "✓ deploy complete");
}

fn now_ts() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
