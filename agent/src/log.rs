//! Logging helpers + shell command execution.

use std::collections::BTreeMap;
use std::io::Write;
use std::process::Stdio;
use std::time::Duration;

use futures_util::SinkExt;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::MaybeTlsStream;
use tokio_tungstenite::WebSocketStream;
use tracing::error;

use crate::protocol::{AgentOut, DeployStatus, LogStream};

/// A single line of captured child-process output, tagged by stream.
#[derive(Debug, Clone)]
pub(crate) struct LogLine {
    pub stream: LogStream,
    pub data: String,
}

/// The WebSocket connection type used throughout the agent.
pub(crate) type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Emit one log line: send it over WS and best-effort append to the
/// per-deployment JSONL file.
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
    append_to_jsonl_log(deployment_id, stream, *line_no, &data);
}

/// Append a single log line to the per-deployment JSONL file.
fn append_to_jsonl_log(
    deployment_id: &str,
    stream: LogStream,
    line_no: u32,
    data: &str,
) {
    let Some(state_dir) = std::env::var_os("VOID_STATE_DIR") else {
        return;
    };
    let path = std::path::PathBuf::from(state_dir)
        .join("logs")
        .join(format!("{}.jsonl", deployment_id));
    let record = serde_json::json!({
        "ts": crate::crypto::now_ts(),
        "deployment_id": deployment_id,
        "line": line_no,
        "stream": stream,
        "data": data,
    });
    let Ok(record_str) = serde_json::to_string(&record) else {
        return;
    };
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = f.write_all(format!("{}\n", record_str).as_bytes());
    }
}

/// Report the final deployment status back to the worker.
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

/// Run a shell command (`sh -c <cmd>`) to completion, streaming its
/// stdout/stderr to the WS as log lines. Returns the process exit code,
/// or -1 if it was killed by the timeout or failed to spawn.
pub(crate) async fn run_shell(
    cmd: &str,
    cwd: &std::path::Path,
    env: &BTreeMap<String, String>,
    timeout_s: u64,
    deployment_id: &str,
    line_no: &mut u32,
    ws: &mut WsStream,
) -> i32 {
    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(cmd)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in env {
        command.env(k, v);
    }

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            emit_log(line_no, deployment_id, ws, LogStream::Stderr, format!("spawn failed: {}\n", e)).await;
            return -1;
        }
    };

    let (tx, mut rx) = mpsc::channel::<LogLine>(64);
    if let Some(out) = child.stdout.take() {
        let txc = tx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(out).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if txc.send(LogLine { stream: LogStream::Stdout, data: format!("{}\n", line) }).await.is_err() {
                    break;
                }
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let txc = tx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(err).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if txc.send(LogLine { stream: LogStream::Stderr, data: format!("{}\n", line) }).await.is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);

    // Stream logs until the child exits (stdout/stderr tasks drop their
    // tx clones when the pipes close, so rx.recv() returns None then).
    let result = tokio::time::timeout(Duration::from_secs(timeout_s), async {
        while let Some(line) = rx.recv().await {
            emit_log(line_no, deployment_id, ws, line.stream, line.data).await;
        }
        child.wait().await
    })
    .await;

    match result {
        Ok(status) => match status {
            Ok(s) => s.code().unwrap_or(-1),
            Err(_) => -1,
        },
        Err(_) => {
            emit_log(line_no, deployment_id, ws, LogStream::Stderr,
                format!("command timed out after {}s, killing\n", timeout_s)).await;
            let _ = child.start_kill();
            let _ = child.wait().await;
            -1
        }
    }
}
