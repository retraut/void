//! WebSocket connection lifecycle: connect, register, heartbeat, dispatch.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};
use tokio::time::interval;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Message};
use tracing::{debug, error, info, warn};
use anyhow::Context;

use crate::config::Config;
use crate::crypto;
use crate::deploy;
use crate::keys::Identity;
use crate::log::WsStream;
use crate::protocol::{AgentOut, Metrics, WorkerToAgent};

pub(crate) async fn run_session(cfg: &Config, identity: &Arc<Identity>) -> anyhow::Result<()> {
    // System info for CPU/memory metrics
    let mut sys = System::new_with_specifics(
        RefreshKind::nothing()
            .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
            .with_memory(MemoryRefreshKind::everything()),
    );
    // Small delay to let CPU measurement accumulate
    tokio::time::sleep(Duration::from_millis(200)).await;

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
    ws.send(Message::text(serde_json::to_string(&register)?))
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
                sys.refresh_cpu_usage();
                sys.refresh_memory();
                let load_avg = read_load_avg();
                let cpu_count = Some(sys.cpus().len() as u32);
                let pressure_tier = load_avg
                    .and_then(|la| cpu_count.map(|c| classify_pressure(la[0], c)))
                    .or(Some(crate::protocol::PressureTier::Light));
                let metrics = Some(Metrics {
                    cpu_percent: sys.global_cpu_usage() as f64,
                    memory_mb: sys.used_memory() as f64 / 1024.0 / 1024.0,
                    memory_percent: sys.used_memory() as f64 / sys.total_memory() as f64 * 100.0,
                    load_avg,
                    cpu_count,
                    pressure_tier,
                });
                let hb = AgentOut::Heartbeat {
                    timestamp: crypto::now_ts(),
                    metrics,
                };
                if let Err(e) = ws.send(Message::text(serde_json::to_string(&hb)?)).await {
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
                            info!("starting heartbeat (5s interval)");
                            let mut hb = interval(Duration::from_secs(5));
                            hb.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
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
) -> anyhow::Result<bool> {
    // Parse the frame with serde — `deny_unknown_fields` on the Rust side
    // matches the Zod `.strict()` on the TS side. Either side rejects drift.
    let frame: WorkerToAgent = match serde_json::from_str(text) {
        Ok(f) => f,
        Err(e) => {
            warn!(error = %e, raw = %text, "invalid frame from server (protocol drift?)");
            let err = serde_json::to_string(&AgentOut::DeployDone {
                deployment_id: "".into(),
                status: crate::protocol::DeployStatus::Failed,
                url: None,
                local_url: None,
                error: Some(format!("invalid frame: {}", e)),
            })
            .unwrap_or_else(|_| r#"{"type":"error","code":"bad_frame"}"#.to_string());
            let _ = ws.send(Message::text(err)).await;
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
            let inventory = AgentOut::Inventory { inventory: crate::inventory::collect() };
            if let Err(error) = ws.send(Message::text(serde_json::to_string(&inventory)?)).await {
                warn!(error = %error, "failed to send server inventory");
            }
            return Ok(true);
        }
        WorkerToAgent::Ping {} => {
            let ready = AgentOut::Ready { timestamp: crypto::now_ts() };
            ws.send(Message::text(serde_json::to_string(&ready)?)).await.ok();
        }
        WorkerToAgent::Pipeline {
            deployment_id,
            steps,
            sig,
        } => {
            // CRITICAL: Verify HMAC signature if AGENT_SHARED_SECRET is set
            if let Some(secret) = &cfg.agent_shared_secret {
                let Some(sig_str) = &sig else {
                    warn!("pipeline message has no signature but AGENT_SHARED_SECRET is set — rejecting");
                    let _ = ws
                        .send(Message::text(
                            r#"{"type":"error","code":"missing_signature"}"#.to_string(),
                        ))
                        .await;
                    return Ok(false);
                };
                let payload = crypto::PipelineNoSig::from_frame(&deployment_id, &steps);
                let payload_str = payload.canonical_json();
                let valid = crypto::verify_hmac_sha256(secret, &payload_str, sig_str);
                if !valid {
                    warn!("HMAC signature verification FAILED for pipeline — rejecting");
                    let _ = ws
                        .send(Message::text(
                            r#"{"type":"error","code":"invalid_signature"}"#.to_string(),
                        ))
                        .await;
                    return Ok(false);
                }
                info!("✓ pipeline signature verified");
            }

            info!(deployment_id = %deployment_id, n = steps.len(), "pipeline requested");
            deploy::run_pipeline(deployment_id, steps, cfg.clone(), ws).await;
        }
        WorkerToAgent::Shutdown {} => {
            info!("shutdown requested, exiting");
            std::process::exit(0);
        }
        WorkerToAgent::TokenRotation {
            session_token,
            sig,
        } => {
            // Worker pushed a freshly-rotated session_token over the open WS.
            // Verify HMAC (if AGENT_SHARED_SECRET is set), persist to disk, and
            // keep the connection alive — no reconnect needed.
            if let Some(secret) = &cfg.agent_shared_secret {
                if let Some(sig_str) = &sig {
                    let payload = crypto::token_rotation_canonical(&session_token);
                    if !crypto::verify_hmac_sha256(secret, &payload, sig_str) {
                        warn!("token_rotation HMAC verification FAILED — ignoring");
                        return Ok(false);
                    }
                    info!("✓ token_rotation signature verified");
                } else {
                    warn!("token_rotation has no signature but AGENT_SHARED_SECRET is set — ignoring");
                    return Ok(false);
                }
            }
            let token_path = cfg.state_dir().join("session_token");
            let _ = std::fs::create_dir_all(cfg.state_dir());
            if let Err(e) = std::fs::write(&token_path, &session_token) {
                warn!(error = %e, "failed to persist rotated session_token");
                return Ok(false);
            }
            info!(token = %session_token, "session_token rotated (written to disk)");
        }
        WorkerToAgent::Error { code, message } => {
            warn!(code = %code, message = ?message, "← server error frame");
        }
    }

    Ok(false)
}

/// Read the 1/5/15-min load average from /proc/loadavg (Linux only).
/// Returns None on non-Linux or if the file can't be parsed.
fn read_load_avg() -> Option<[f64; 3]> {
    let raw = std::fs::read_to_string("/proc/loadavg").ok()?;
    let mut parts = raw.split_whitespace();
    let a = parts.next()?.parse::<f64>().ok()?;
    let b = parts.next()?.parse::<f64>().ok()?;
    let c = parts.next()?.parse::<f64>().ok()?;
    Some([a, b, c])
}

/// Classify server pressure from the 1-min load average normalized by
/// the number of logical CPU cores. Mirrors the SPA's `loadTier`.
fn classify_pressure(load1: f64, cpu_count: u32) -> crate::protocol::PressureTier {
    let per_core = load1 / cpu_count.max(1) as f64;
    if per_core < 0.7 {
        crate::protocol::PressureTier::Light
    } else if per_core < 1.5 {
        crate::protocol::PressureTier::Medium
    } else if per_core < 3.0 {
        crate::protocol::PressureTier::High
    } else {
        crate::protocol::PressureTier::ExtraHigh
    }
}
