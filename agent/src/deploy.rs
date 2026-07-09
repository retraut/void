//! Pipeline execution — a thin shell executor.
//!
//! A deployment is just an ordered list of shell steps sent by the Worker.
//! We run each step in turn (streaming logs to the WS), stop at the first
//! failure, then report DeployDone. The agent owns no deploy logic —
//! clone/build/run/tunnel are all decided upstream.

use std::path::Path;

use tracing::{error, info};

use crate::config::Config;
use crate::log::{emit_done, run_shell, WsStream};
use crate::protocol::{DeployStatus, PipelineStep};

/// Run a deployment pipeline: execute each shell step in order.
pub(crate) async fn run_pipeline(
    deployment_id: String,
    steps: Vec<PipelineStep>,
    cfg: Config,
    ws: &mut WsStream,
) {
    info!(deployment_id = %deployment_id, n = steps.len(), "▶ running pipeline");

    // Isolate each deployment in its own work dir.
    let work_dir = cfg.work_dir().join(&deployment_id);

    // Clean any prior deployment dir, then (re)create it.
    let _ = std::fs::remove_dir_all(&work_dir);
    if let Err(e) = std::fs::create_dir_all(&work_dir) {
        error!(error = %e, dir = %work_dir.display(), "could not create work dir");
        emit_done(&deployment_id, ws, DeployStatus::Failed, None, None, Some(format!("work dir error: {}", e))).await;
        return;
    }

    let mut line_no = 0u32;

    for (i, step) in steps.iter().enumerate() {
        let cwd = step
            .cwd
            .as_deref()
            .map(Path::new)
            .unwrap_or(&work_dir);

        info!(deployment_id = %deployment_id, step = i, "▶ step: {}", step.cmd);
        let exit = run_shell(
            &step.cmd,
            cwd,
            &step.env,
            step.timeout_s,
            &deployment_id,
            &mut line_no,
            ws,
        )
        .await;

        if exit != 0 {
            let err = format!("step {} failed (exit {})", i, exit);
            error!(deployment_id = %deployment_id, step = i, "✗ {}", err);
            emit_done(&deployment_id, ws, DeployStatus::Failed, None, None, Some(err)).await;
            return;
        }
    }

    info!(deployment_id = %deployment_id, "✓ pipeline complete");
    emit_done(
        &deployment_id,
        ws,
        DeployStatus::Success,
        None,
        None,
        None,
    )
    .await;
}
