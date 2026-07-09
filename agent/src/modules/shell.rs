//! shell module — run an arbitrary one-off command.

use std::future::Future;
use std::pin::Pin;
use serde::Deserialize;
use std::collections::BTreeMap;

use tokio::process::Command;

use crate::log::emit_log;
use crate::pipeline::{Module, ModuleResult, StepCtx};

#[derive(Debug, Deserialize)]
struct Params {
    cmd: String,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default = "default_timeout")]
    timeout_s: u64,
}

fn default_timeout() -> u64 {
    60
}

pub(crate) struct Shell {
    cmd: String,
    cwd: Option<String>,
    env: BTreeMap<String, String>,
    timeout_s: u64,
}

impl Shell {
    pub(crate) fn from_params(params: &serde_json::Value) -> Self {
        let p: Params = serde_json::from_value(params.clone())
            .unwrap_or_else(|e| panic!("shell: invalid params: {}", e));
        Shell { cmd: p.cmd, cwd: p.cwd, env: p.env, timeout_s: p.timeout_s }
    }
}

impl Module for Shell {
    fn name(&self) -> &'static str {
        "shell"
    }

    fn run<'a>(&'a self, ctx: &'a mut StepCtx<'_>) -> Pin<Box<dyn Future<Output = ModuleResult> + Send + 'a>> {
        Box::pin(async move {
        let mut command = Command::new("sh");
        command.arg("-c").arg(&self.cmd);
        if let Some(dir) = &self.cwd {
            command.current_dir(dir);
        }
        for (k, v) in &self.env {
            command.env(k, v);
        }

        let result = tokio::time::timeout(std::time::Duration::from_secs(self.timeout_s), async {
            command
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
                .await
        })
        .await;

        match result {
            Ok(Ok(out)) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let stderr = String::from_utf8_lossy(&out.stderr);
                if !stdout.is_empty() {
                    emit_log(&mut ctx.line_no, &ctx.deployment_id, ctx.ws, crate::protocol::LogStream::Stdout, stdout.into_owned()).await;
                }
                if !stderr.is_empty() {
                    emit_log(&mut ctx.line_no, &ctx.deployment_id, ctx.ws, crate::protocol::LogStream::Stderr, stderr.into_owned()).await;
                }
                if !out.status.success() {
                    return ModuleResult::fail(format!("shell exited {}", out.status.code().unwrap_or(-1)));
                }
                ModuleResult::ok()
            }
            Ok(Err(e)) => ModuleResult::fail(format!("spawn failed: {}", e)),
            Err(_) => ModuleResult::fail(format!("timeout after {}s", self.timeout_s)),
        }
        })
    }
}
