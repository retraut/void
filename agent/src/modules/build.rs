//! build module — build the cloned project.

use std::future::Future;
use std::pin::Pin;
use serde::Deserialize;
use tracing::info;

use crate::detect;
use crate::log::emit_log;
use crate::log::run_shell_streaming;
use crate::protocol::LogStream;
use crate::pipeline::{Module, ModuleResult, StepCtx};

#[derive(Debug, Deserialize)]
struct Params {
    #[serde(default)]
    build_command: Option<String>,
}

pub(crate) struct Build {
    build_command: Option<String>,
}

impl Build {
    pub(crate) fn from_params(params: &serde_json::Value) -> Self {
        let p: Params = serde_json::from_value(params.clone()).unwrap_or(Params { build_command: None });
        Build { build_command: p.build_command }
    }
}

impl Module for Build {
    fn name(&self) -> &'static str {
        "build"
    }

    fn run<'a>(&'a self, ctx: &'a mut StepCtx<'_>) -> Pin<Box<dyn Future<Output = ModuleResult> + Send + 'a>> {
        Box::pin(async move {
        let cmd = match &self.build_command {
            Some(c) => c.clone(),
            None => {
                let detected = detect::detect(&ctx.work_dir);
                emit_log(
                    &mut ctx.line_no,
                    &ctx.deployment_id,
                    ctx.ws,
                    LogStream::Stdout,
                    format!("→ 🔍 auto-detected framework: {}\n", detected.framework),
                )
                .await;
                match detected.build_command {
                    Some(c) => c,
                    None => {
                        emit_log(
                            &mut ctx.line_no,
                            &ctx.deployment_id,
                            ctx.ws,
                            LogStream::Stdout,
                            "→ no build_command, skipping\n".to_string(),
                        )
                        .await;
                        return ModuleResult::ok();
                    }
                }
            }
        };

        emit_log(
            &mut ctx.line_no,
            &ctx.deployment_id,
            ctx.ws,
            LogStream::Stdout,
            format!("→ build: $ {}\n", cmd),
        )
        .await;

        let exit = run_shell_streaming(&cmd, &ctx.work_dir, &ctx.deployment_id, &mut ctx.line_no, ctx.ws).await;
        if exit != 0 {
            emit_log(
                &mut ctx.line_no,
                &ctx.deployment_id,
                ctx.ws,
                LogStream::Stderr,
                format!("build failed with exit code {}\n", exit),
            )
            .await;
            return ModuleResult::fail(format!("build failed (exit {})", exit));
        }

        emit_log(
            &mut ctx.line_no,
            &ctx.deployment_id,
            ctx.ws,
            LogStream::Stdout,
            "→ ✓ build complete\n".to_string(),
        )
        .await;
        info!(deployment_id = %ctx.deployment_id, "✓ build complete");
        ModuleResult::ok()
        })
    }
}
