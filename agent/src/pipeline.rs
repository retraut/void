//! Pipeline: an ordered list of composable `Module`s.
//!
//! Each module runs in sequence and may publish values (port, local_url,
//! container_id, …) into the shared `StepCtx`, which downstream modules
//! read. Modules are generic primitives — product specifics (caddy, any
//! container) live in the step spec / compose YAML, never in Rust.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Deserialize;
use std::future::Future;
use std::pin::Pin;
use tracing::{error, info};

use crate::log::WsStream;

/// Shared state threaded through every module in a pipeline run.
pub(crate) struct StepCtx<'a> {
    pub deployment_id: String,
    /// Working directory for this deployment (git clone target, etc.).
    pub work_dir: PathBuf,
    /// Live WebSocket for streaming logs back to the worker.
    pub ws: &'a mut WsStream,
    /// Monotonic log line counter (persists across steps).
    pub line_no: u32,
    /// Outputs published by previous steps, keyed by name.
    pub outputs: BTreeMap<String, String>,
}

impl StepCtx<'_> {
    /// Get a previously-published output, or None.
    pub(crate) fn get(&self, key: &str) -> Option<&str> {
        self.outputs.get(key).map(String::as_str)
    }

    /// Publish an output for downstream modules.
    pub(crate) fn set(&mut self, key: &str, value: impl Into<String>) {
        self.outputs.insert(key.to_string(), value.into());
    }
}

/// Result of running a single module.
pub(crate) struct ModuleResult {
    /// Deployment-level status to report (for the final DeployDone).
    pub failed: bool,
    /// Optional error message if `failed`.
    pub error: Option<String>,
}

impl ModuleResult {
    pub(crate) fn ok() -> Self {
        ModuleResult { failed: false, error: None }
    }
    pub(crate) fn fail(msg: impl Into<String>) -> Self {
        ModuleResult { failed: true, error: Some(msg.into()) }
    }
}

/// A composable pipeline step. Implemented by each primitive module.
pub(crate) trait Module: Send + Sync {
    /// Stable module name (matches the wire `module` field).
    fn name(&self) -> &'static str;

    /// Execute the step against the shared context.
    fn run<'a>(&'a self, ctx: &'a mut StepCtx<'_>) -> Pin<Box<dyn Future<Output = ModuleResult> + Send + 'a>>;
}

/// A pipeline is just an ordered list of modules.
pub(crate) struct Pipeline {
    pub steps: Vec<Box<dyn Module>>,
}

impl Pipeline {
    /// Run each module in order. Stops at the first failure and reports it.
    pub(crate) async fn run(&self, ctx: &mut StepCtx<'_>) {
        for step in &self.steps {
            info!(deployment_id = %ctx.deployment_id, step = step.name(), "▶ running module");
            let result = step.run(ctx).await;
            if result.failed {
                let msg = result.error.unwrap_or_else(|| "module failed".into());
                error!(deployment_id = %ctx.deployment_id, step = step.name(), error = %msg, "✗ module failed");
                // Mark the whole deployment failed; caller emits DeployDone.
                ctx.set("__failed", &msg);
                return;
            }
        }
        info!(deployment_id = %ctx.deployment_id, "✓ pipeline complete");
    }
}

/// A single step specification as received over the wire. The `module`
/// field selects which primitive to build; `params` carries its config.
/// Kept loose (untyped JSON) at the envelope level so new modules don't
/// require a protocol change — each module deserializes its own params.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct StepSpec {
    pub module: String,
    #[serde(default)]
    pub params: serde_json::Value,
}
