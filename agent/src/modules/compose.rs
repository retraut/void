//! compose module — run an arbitrary `docker compose` project.
//!
//! This is the universal container primitive: caddy, any image, sidecars,
//! multi-service stacks — all expressed via the YAML you pass in. The agent
//! only writes the file and runs `docker compose up -d`.

use std::future::Future;
use std::pin::Pin;
use serde::Deserialize;
use std::collections::BTreeMap;

use crate::log::emit_log;
use crate::log::run_cmd_streaming_inner;
use crate::protocol::LogStream;
use crate::pipeline::{Module, ModuleResult, StepCtx};

#[derive(Debug, Deserialize)]
struct Params {
    project_name: String,
    yaml: String,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

pub(crate) struct Compose {
    project_name: String,
    yaml: String,
    env: BTreeMap<String, String>,
}

impl Compose {
    pub(crate) fn from_params(params: &serde_json::Value) -> Self {
        let p: Params = serde_json::from_value(params.clone())
            .unwrap_or_else(|e| panic!("compose: invalid params: {}", e));
        Compose { project_name: p.project_name, yaml: p.yaml, env: p.env }
    }
}

impl Module for Compose {
    fn name(&self) -> &'static str {
        "compose"
    }

    fn run<'a>(&'a self, ctx: &'a mut StepCtx<'_>) -> Pin<Box<dyn Future<Output = ModuleResult> + Send + 'a>> {
        Box::pin(async move {
            let deployment_id = format!("compose-{}", &ctx.deployment_id);
            let mut line_no = 0u32;
            let tmpdir = std::env::temp_dir().join(format!("void-compose-{}", &ctx.deployment_id));
            if let Err(e) = std::fs::create_dir_all(&tmpdir) {
                emit_log(&mut line_no, &deployment_id, ctx.ws, LogStream::Stderr,
                    format!("mkdir failed: {}\n", e)).await;
                return ModuleResult::fail(format!("mkdir failed: {}", e));
            }
            let compose_path = tmpdir.join("docker-compose.yml");
            if let Err(e) = std::fs::write(&compose_path, &self.yaml) {
                let _ = std::fs::remove_dir_all(&tmpdir);
                return ModuleResult::fail(format!("write compose file: {}", e));
            }

            emit_log(&mut line_no, &deployment_id, ctx.ws, LogStream::Stdout,
                format!("→ docker compose -p {} up -d\n", self.project_name)).await;

            let mut command = tokio::process::Command::new("docker");
            command.arg("compose")
                .arg("-p").arg(&self.project_name)
                .arg("-f").arg(&compose_path)
                .arg("up").arg("-d")
                .current_dir(&tmpdir)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            for (k, v) in &self.env {
                command.env(k, v);
            }

            let exit = run_cmd_streaming_inner(
                "docker", &mut command, &deployment_id, &mut line_no, ctx.ws,
            ).await;
            let _ = std::fs::remove_dir_all(&tmpdir);

            if exit != 0 {
                return ModuleResult::fail(format!("docker compose up exited {}", exit));
            }
            // Worker can `docker ps` to find container ids.
            ModuleResult::ok()
        })
    }
}
