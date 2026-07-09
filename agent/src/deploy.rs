//! Pipeline orchestration for deployments.
//!
//! The worker sends a `pipeline` frame: an ordered list of module steps.
//! The agent builds each module from the registry and runs them in order,
//! threading shared state (work dir, logs, published outputs) through.

use std::collections::BTreeMap;

use crate::config::Config;
use crate::log::{emit_done, WsStream};
use crate::modules::registry::build_module;
use crate::pipeline::{Pipeline, StepCtx, StepSpec};
use crate::protocol::DeployStatus;

/// Run a deployment described by an explicit list of step specs.
pub(crate) async fn run_pipeline(
    deployment_id: String,
    steps: Vec<StepSpec>,
    cfg: Config,
    ws: &mut WsStream,
) {
    let line_no = 0u32;
    let work_dir = std::env::temp_dir().join(format!("void-build-{}", &deployment_id));
    if work_dir.exists() {
        let _ = std::fs::remove_dir_all(&work_dir);
    }
    if let Err(e) = std::fs::create_dir_all(&work_dir) {
        emit_done(&deployment_id, ws, DeployStatus::Failed, None, None, Some(e.to_string())).await;
        return;
    }

    let mut pipeline = Pipeline { steps: Vec::with_capacity(steps.len()) };
    for spec in &steps {
        pipeline.steps.push(build_module(&spec.module, &spec.params));
    }

    let mut ctx = StepCtx {
        deployment_id: deployment_id.clone(),
        work_dir,
        ws,
        line_no,
        outputs: BTreeMap::new(),
    };

    pipeline.run(&mut ctx).await;

    if let Some(err) = ctx.get("__failed") {
        // A module failed; report it.
        let public_url = ctx.get("public_url").map(String::from);
        let local_url = ctx.get("local_url").map(String::from);
        emit_done(&deployment_id, ctx.ws, DeployStatus::Failed, public_url, local_url, Some(err.to_string())).await;
        return;
    }

    // Success. Derive URLs from the context.
    let local_url = ctx.get("local_url").map(String::from);
    let public_url = ctx
        .get("public_url")
        .map(String::from)
        .or_else(|| {
            let port = ctx.get("port")?;
            Some(cfg.public_url_template.replace("{port}", port).replace("{deployment_id}", &deployment_id))
        });

    emit_done(&deployment_id, ctx.ws, DeployStatus::Success, public_url, local_url, None).await;
}
