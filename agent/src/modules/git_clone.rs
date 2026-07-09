//! git_clone module — fetch the source repo into the work dir.

use std::future::Future;
use std::pin::Pin;
use serde::Deserialize;
use tracing::info;

use crate::log::emit_log;
use crate::log::run_cmd_streaming;
use crate::protocol::LogStream;
use crate::pipeline::{Module, ModuleResult, StepCtx};

#[derive(Debug, Deserialize)]
struct Params {
    repo_url: String,
    #[serde(default = "default_ref")]
    ref_: String,
}

fn default_ref() -> String {
    "main".to_string()
}

pub(crate) struct GitClone {
    repo_url: String,
    ref_: String,
}

impl GitClone {
    pub(crate) fn from_params(params: &serde_json::Value) -> Self {
        let p: Params = serde_json::from_value(params.clone()).unwrap_or_else(|e| {
            panic!("git_clone: invalid params: {}", e)
        });
        GitClone { repo_url: p.repo_url, ref_: p.ref_ }
    }
}

impl Module for GitClone {
    fn name(&self) -> &'static str {
        "git_clone"
    }

    fn run<'a>(&'a self, ctx: &'a mut StepCtx<'_>) -> Pin<Box<dyn Future<Output = ModuleResult> + Send + 'a>> {
        Box::pin(async move {
        emit_log(
            &mut ctx.line_no,
            &ctx.deployment_id,
            ctx.ws,
            LogStream::Stdout,
            format!("→ git clone {} (depth 1, ref {})\n", self.repo_url, self.ref_),
        )
        .await;

        let exit = run_cmd_streaming(
            "git",
            &["clone", "--depth", "1", "--branch", &self.ref_, &self.repo_url, "."],
            &ctx.work_dir,
            &ctx.deployment_id,
            &mut ctx.line_no,
            ctx.ws,
        )
        .await;

        if exit != 0 {
            emit_log(
                &mut ctx.line_no,
                &ctx.deployment_id,
                ctx.ws,
                LogStream::Stderr,
                format!("git clone failed with exit code {}\n", exit),
            )
            .await;
            return ModuleResult::fail(format!("git clone failed (exit {})", exit));
        }

        emit_log(
            &mut ctx.line_no,
            &ctx.deployment_id,
            ctx.ws,
            LogStream::Stdout,
            "→ ✓ clone complete\n".to_string(),
        )
        .await;
        info!(deployment_id = %ctx.deployment_id, "✓ clone complete");
        ModuleResult::ok()
        })
    }
}
