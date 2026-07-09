//! daemon module — launch a long-lived detached process.

use std::future::Future;
use std::pin::Pin;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::time::Duration;
use tracing::{info, warn};

use crate::pipeline::{Module, ModuleResult, StepCtx};

#[derive(Debug, Deserialize)]
struct Params {
    /// Executable + args, e.g. ["cloudflared", "tunnel", "--no-autoupdate", "run"].
    cmd: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    /// PID file for orphan cleanup. If present, any previously tracked
    /// instance is SIGTERM'd before a new one starts.
    #[serde(default)]
    pid_file: Option<String>,
}

pub(crate) struct Daemon {
    cmd: Vec<String>,
    env: BTreeMap<String, String>,
    pid_file: Option<String>,
}

impl Daemon {
    pub(crate) fn from_params(params: &serde_json::Value) -> Self {
        let p: Params = serde_json::from_value(params.clone())
            .unwrap_or_else(|e| panic!("daemon: invalid params: {}", e));
        Daemon { cmd: p.cmd, env: p.env, pid_file: p.pid_file }
    }
}

impl Module for Daemon {
    fn name(&self) -> &'static str {
        "daemon"
    }

    fn run<'a>(&'a self, ctx: &'a mut StepCtx<'_>) -> Pin<Box<dyn Future<Output = ModuleResult> + Send + 'a>> {
        Box::pin(async move {
            if self.cmd.is_empty() {
                return ModuleResult::fail("daemon: empty cmd");
            }

            // 1. Kill any previously tracked instance (orphan-safe).
            if let Some(pid_path) = self.pid_file.as_deref() {
                if let Ok(pid_str) = std::fs::read_to_string(pid_path) {
                    if let Ok(pid) = pid_str.trim().parse::<i32>() {
                        #[cfg(unix)]
                        unsafe {
                            libc::kill(pid, libc::SIGTERM);
                        }
                        let _ = std::fs::remove_file(pid_path);
                        info!(deployment_id = %ctx.deployment_id, old_pid = pid, "killed previous daemon instance");
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                }
            }

            // 2. Spawn detached.
            let mut command = Command::new(&self.cmd[0]);
            command.args(&self.cmd[1..])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(false);
            for (k, v) in &self.env {
                command.env(k, v);
            }

            let mut child = match command.spawn() {
                Ok(c) => c,
                Err(e) => return ModuleResult::fail(format!("spawn daemon failed: {}", e)),
            };

            // 3. Save PID for next-time cleanup.
            if let (Some(pid_path), Some(pid)) = (self.pid_file.as_deref(), child.id()) {
                if let Some(parent) = Path::new(pid_path).parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(pid_path, pid.to_string());
            }

            // 4. Stream initial output (best-effort, bounded).
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            if let Some(out) = stdout {
                let mut reader = BufReader::new(out).lines();
                let _ = tokio::time::timeout(Duration::from_secs(3), async {
                    while let Ok(Some(line)) = reader.next_line().await {
                        info!(target: "daemon", "{}", line);
                    }
                }).await;
            }
            if let Some(err) = stderr {
                let mut reader = BufReader::new(err).lines();
                let _ = tokio::time::timeout(Duration::from_secs(3), async {
                    while let Ok(Some(line)) = reader.next_line().await {
                        warn!(target: "daemon", "{}", line);
                    }
                }).await;
            }

            // 5. Detach: don't wait on the child.
            tokio::spawn(async move {
                let _ = child.wait().await;
                info!("daemon process exited");
            });

            ModuleResult::ok()
        })
    }
}
