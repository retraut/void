//! run module — serve a process on the host and health-check it.
//!
//! Publishes `port` and `local_url` for downstream modules (caddy, tunnel).
//! If no `serve_command` is given and no `port` is set, the step is a
//! no-op (build-only deploy).

use std::future::Future;
use std::pin::Pin;
use serde::Deserialize;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::sleep;
use tracing::info;

use crate::detect;
use crate::log::drain_serve_logs_to_ws;
use crate::log::emit_log;
use crate::log::LogLine;
use crate::protocol::LogStream;
use crate::pipeline::{Module, ModuleResult, StepCtx};

#[derive(Debug, Deserialize)]
struct Params {
    #[serde(default)]
    serve_command: Option<String>,
    #[serde(default)]
    port: Option<u16>,
}

pub(crate) struct Run {
    serve_command: Option<String>,
    port: Option<u16>,
}

impl Run {
    pub(crate) fn from_params(params: &serde_json::Value) -> Self {
        let p: Params = serde_json::from_value(params.clone()).unwrap_or(Params { serve_command: None, port: None });
        Run { serve_command: p.serve_command, port: p.port }
    }
}

impl Module for Run {
    fn name(&self) -> &'static str {
        "run"
    }

    fn run<'a>(&'a self, ctx: &'a mut StepCtx<'_>) -> Pin<Box<dyn Future<Output = ModuleResult> + Send + 'a>> {
        Box::pin(async move {
            let detected = self.serve_command.clone().or_else(|| detect::detect(&ctx.work_dir).serve_command);
            let port = self.port.or_else(|| {
                if self.serve_command.is_none() {
                    Some(detect::detect(&ctx.work_dir).port)
                } else {
                    Some(0)
                }
            });

            let Some(cmd) = detected else {
                emit_log(
                    &mut ctx.line_no,
                    &ctx.deployment_id,
                    ctx.ws,
                    LogStream::Stdout,
                    "→ no serve_command, skipping (build-only)\n".to_string(),
                )
                .await;
                return ModuleResult::ok();
            };

            let port = port.unwrap_or(0);
            let local_url = format!("http://127.0.0.1:{}", port);
            emit_log(
                &mut ctx.line_no,
                &ctx.deployment_id,
                ctx.ws,
                LogStream::Stdout,
                format!("→ serve: $ {} (port {})\n", cmd, port),
            )
            .await;

            let mut child = match Command::new("sh")
                .arg("-c")
                .arg(&cmd)
                .current_dir(&ctx.work_dir)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true)
                .spawn()
            {
                Ok(c) => c,
                Err(e) => {
                    emit_log(
                        &mut ctx.line_no,
                        &ctx.deployment_id,
                        ctx.ws,
                        LogStream::Stderr,
                        format!("serve spawn failed: {}\n", e),
                    )
                    .await;
                    return ModuleResult::fail(e.to_string());
                }
            };

            // Stream stdout/stderr to ws via a channel.
            let (tx, mut rx) = mpsc::channel::<LogLine>(64);
            if let Some(stdout) = child.stdout.take() {
                let txc = tx.clone();
                tokio::spawn(async move {
                    let mut reader = BufReader::new(stdout).lines();
                    while let Ok(Some(line)) = reader.next_line().await {
                        if txc.send(LogLine { stream: LogStream::Stdout, data: format!("{}\n", line) }).await.is_err() {
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
                        if txc.send(LogLine { stream: LogStream::Stderr, data: format!("{}\n", line) }).await.is_err() {
                            break;
                        }
                    }
                });
            }
            drop(tx);

            drain_serve_logs_to_ws(&ctx.deployment_id, &mut ctx.line_no, &mut rx, ctx.ws).await;

            // Health check with a 10s grace period.
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            let mut healthy = false;
            let mut last_err: Option<String> = None;
            while tokio::time::Instant::now() < deadline {
                match check_health(&local_url).await {
                    Ok(()) => { healthy = true; break; }
                    Err(e) => { last_err = Some(e); sleep(Duration::from_millis(500)).await; }
                }
            }

            if !healthy {
                emit_log(
                    &mut ctx.line_no,
                    &ctx.deployment_id,
                    ctx.ws,
                    LogStream::Stderr,
                    format!("✗ health check FAILED: serve not responding on {} after 10s (last err: {})\n", local_url, last_err.unwrap_or_else(|| "none".into())),
                )
                .await;
                let _ = child.kill().await;
                let _ = child.wait().await;
                return ModuleResult::fail("health check failed: serve did not respond 2xx within 10s");
            }

            emit_log(
                &mut ctx.line_no,
                &ctx.deployment_id,
                ctx.ws,
                LogStream::Stdout,
                format!("→ ✓ serve alive on {}\n", local_url),
            )
            .await;

            // Publish for downstream modules (caddy, tunnel).
            ctx.set("port", port.to_string());
            ctx.set("local_url", &local_url);
            ctx.set("serve_pid", child.id().map(|p| p.to_string()).unwrap_or_default());

            info!(deployment_id = %ctx.deployment_id, local_url, "✓ serve alive");
            // Wait for the serve process to exit (keeps it alive for the session).
            let _ = child.wait().await;
            ModuleResult::ok()
        })
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
