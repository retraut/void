//! One-off shell handler.

use std::collections::BTreeMap;
use std::time::Duration;

use futures_util::SinkExt;
use tokio::process::Command;
use tokio_tungstenite::tungstenite::Message;

use crate::log::WsStream;
use crate::protocol::AgentOut;

/// Run an arbitrary shell command. Used for one-off ops like
/// `apt-get update && unattended-upgrades`. The Worker is responsible
/// for allowlisting what commands are allowed — this handler does
/// no validation of its own.
pub(crate) async fn handle_shell(
    task_id: String,
    cmd: String,
    cwd: Option<String>,
    env: BTreeMap<String, String>,
    timeout_s: u64,
    ws: &mut WsStream,
) {
    let mut command = Command::new("sh");
    command.arg("-c").arg(&cmd);
    if let Some(dir) = &cwd {
        command.current_dir(dir);
    }
    for (k, v) in &env {
        command.env(k, v);
    }

    let result = tokio::time::timeout(Duration::from_secs(timeout_s), async {
        let out = command
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .await;
        match out {
            Ok(o) => AgentOut::ShellDone {
                task_id: task_id.clone(),
                exit_code: o.status.code().unwrap_or(-1),
                stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
                error: None,
            },
            Err(e) => AgentOut::ShellDone {
                task_id: task_id.clone(),
                exit_code: -1,
                stdout: String::new(),
                stderr: String::new(),
                error: Some(format!("spawn failed: {}", e)),
            },
        }
    })
    .await;

    let msg = match result {
        Ok(m) => m,
        Err(_) => AgentOut::ShellDone {
            task_id: task_id.clone(),
            exit_code: -1,
            stdout: String::new(),
            stderr: String::new(),
            error: Some(format!("timeout after {}s", timeout_s)),
        },
    };
    if let Ok(json) = serde_json::to_string(&msg) {
        let _ = ws.send(Message::text(json)).await;
    }
}
