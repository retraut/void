//! One-off shell + docker compose handlers.

use std::collections::BTreeMap;
use std::time::Duration;

use futures_util::SinkExt;
use tokio::process::Command;
use tokio_tungstenite::tungstenite::Message;

use crate::log::{emit_done, emit_log, run_cmd_streaming_inner, WsStream};
use crate::protocol::{AgentOut, DeployStatus, LogStream};

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

/// Write the YAML to a temp file, run `docker compose -p <name> up -d`,
/// stream the output as Log lines, return the result.
pub(crate) async fn handle_compose_up(
    task_id: String,
    project_name: String,
    yaml: String,
    env: BTreeMap<String, String>,
    ws: &mut WsStream,
) {
    let deployment_id = format!("compose-{}", &task_id);
    let mut line_no = 0u32;
    let tmpdir = std::env::temp_dir().join(format!("void-compose-{}", &task_id));
    if let Err(e) = std::fs::create_dir_all(&tmpdir) {
        emit_done(
            &deployment_id, ws, DeployStatus::Failed, None, None,
            Some(format!("mkdir failed: {}", e)),
        ).await;
        let msg = AgentOut::ComposeUpDone {
            task_id: task_id.clone(),
            container_id: None,
            exit_code: -1,
            error: Some(format!("mkdir failed: {}", e)),
        };
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = ws.send(Message::text(json)).await;
        }
        return;
    }
    let compose_path = tmpdir.join("docker-compose.yml");
    if let Err(e) = std::fs::write(&compose_path, &yaml) {
        let _ = std::fs::remove_dir_all(&tmpdir);
        let msg = AgentOut::ComposeUpDone {
            task_id: task_id.clone(),
            container_id: None,
            exit_code: -1,
            error: Some(format!("write compose file: {}", e)),
        };
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = ws.send(Message::text(json)).await;
        }
        return;
    }

    emit_log(&mut line_no, &deployment_id, ws, LogStream::Stdout,
        format!("→ docker compose -p {} up -d\n", project_name)).await;

    let mut command = Command::new("docker");
    command.arg("compose")
        .arg("-p").arg(&project_name)
        .arg("-f").arg(&compose_path)
        .arg("up").arg("-d")
        .current_dir(&tmpdir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for (k, v) in &env {
        command.env(k, v);
    }

    let exit = run_cmd_streaming_inner(
        "docker", &mut command, &deployment_id, &mut line_no, ws,
    ).await;
    let _ = std::fs::remove_dir_all(&tmpdir);

    let msg = AgentOut::ComposeUpDone {
        task_id: task_id.clone(),
        container_id: None, // Worker can `docker ps` to find it
        exit_code: exit,
        error: if exit != 0 { Some(format!("docker compose up exited {}", exit)) } else { None },
    };
    if let Ok(json) = serde_json::to_string(&msg) {
        let _ = ws.send(Message::text(json)).await;
    }
}
