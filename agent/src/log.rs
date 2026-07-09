//! Logging helpers + child-process output streaming.
//!
//! `LogLine` and `WsStream` are shared types used across the connection,
//! deploy, shell and tunnel modules, so they live here and are re-exported
//! from `main`.

use futures_util::SinkExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::time::Duration;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::MaybeTlsStream;
use tokio_tungstenite::WebSocketStream;
use tracing::{error, warn};

use crate::crypto;
use crate::protocol::{AgentOut, DeployStatus, LogStream};

/// A single line of captured child-process output, tagged by stream.
#[derive(Debug, Clone)]
pub(crate) struct LogLine {
    pub stream: LogStream,
    pub data: String,
}

/// The WebSocket connection type used throughout the agent.
pub(crate) type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub(crate) async fn emit_log(
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
	if let Err(e) = ws.send(Message::text(json)).await {
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
		"ts": crypto::now_ts(),
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

pub(crate) async fn emit_done(
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
    let _ = ws.send(Message::text(json)).await;
}

/// Reads child stdout/stderr line-by-line and writes to ws as Log messages.
/// Uses a select! loop that polls child exit and line readers concurrently.
async fn stream_child_to_ws(
    child: &mut Child,
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

    drain_channel(child, deployment_id, line_no, ws, &mut rx).await;
}

/// Drains a log line channel into the WS, draining child output first then
/// serving output. Shared by `stream_child_to_ws` and the serve loop.
async fn drain_channel(
    child: &mut Child,
    deployment_id: &str,
    line_no: &mut u32,
    ws: &mut WsStream,
    rx: &mut mpsc::Receiver<LogLine>,
) {
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
                        if let Err(e) = ws.send(Message::text(json)).await {
                            warn!(error = %e, "ws send failed, stopping forward");
                            break;
                        }
                    }
                    None => {
                        // Both readers closed. Wait for the child so the
                        // drain doesn't return while it's still running.
                        let _ = child.wait().await;
                        break;
                    }
                }
            }
            _ = tokio::time::sleep_until(drain_deadline) => {
                warn!("log forward timeout, giving up");
                break;
            }
        }
    }
}

/// Drains log lines from `rx` and writes them to `ws` as Log messages.
/// Used by the serve loop (no child handle needed for exit waiting).
pub(crate) async fn drain_serve_logs_to_ws(
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
                        if let Err(e) = ws.send(Message::text(json)).await {
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

pub(crate) async fn run_cmd_streaming(
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
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
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

pub(crate) async fn run_shell_streaming(
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
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
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

/// Like `run_cmd_streaming` but takes a pre-built `Command` so callers
/// can set cwd/env/etc. before spawning.
pub(crate) async fn run_cmd_streaming_inner(
    name: &str,
    command: &mut Command,
    deployment_id: &str,
    line_no: &mut u32,
    ws: &mut WsStream,
) -> i32 {
    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            emit_log(line_no, deployment_id, ws, LogStream::Stderr,
                format!("spawn {} failed: {}\n", name, e)).await;
            return -1;
        }
    };
    stream_child_to_ws(&mut child, deployment_id, line_no, ws).await;
    match child.wait().await {
        Ok(status) => status.code().unwrap_or(-1),
        Err(_) => -1,
    }
}

