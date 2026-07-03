use async_trait::async_trait;
use anyhow::{Context, Result};
use serde_json::Value;
use std::collections::HashMap;
use tracing::info;
use crate::engine::backend::SystemBackend;
use crate::engine::module::{TaskModule, TaskResult};

pub struct SystemdModule {
    name: String,
    service: String,
    state: String,
    enabled: Option<bool>,
    daemon_reload: bool,
}

#[async_trait]
impl TaskModule for SystemdModule {
    fn module_name(&self) -> &'static str { "systemd" }
    fn task_name(&self) -> &str { &self.name }

    fn from_params(task_name: String, params: &HashMap<String, Value>) -> Result<Self> {
        let service = params.get("service")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("systemd: missing 'service'"))?
            .to_string();
        let state = params.get("state").and_then(|v| v.as_str())
            .unwrap_or("started").to_string();
        let enabled = params.get("enabled").and_then(|v| v.as_bool());
        let daemon_reload = params.get("daemon_reload").and_then(|v| v.as_bool()).unwrap_or(false);

        Ok(SystemdModule { name: task_name, service, state, enabled, daemon_reload })
    }

    async fn check_state(&self, backend: &dyn SystemBackend) -> Result<bool> {
        let expected_active = matches!(self.state.as_str(), "started" | "restarted");
        let out = backend.execute("systemctl", &["is-active", &self.service]).await
            .context(format!("systemctl is-active {}", self.service))?;
        let is_active = out.stdout.trim() == "active";

        if is_active != expected_active {
            return Ok(false);
        }

        if let Some(expected_enabled) = self.enabled {
            let out = backend.execute("systemctl", &["is-enabled", &self.service]).await?;
            let is_enabled = out.stdout.trim() == "enabled";
            if is_enabled != expected_enabled {
                return Ok(false);
            }
        }

        Ok(true)
    }

    async fn apply_changes(&self, backend: &dyn SystemBackend) -> Result<TaskResult> {
        if self.daemon_reload {
            backend.execute("systemctl", &["daemon-reload"]).await
                .context("systemctl daemon-reload")?;
            info!("systemctl daemon-reload done");
        }

        let mut output = String::new();

        if let Some(enabled) = self.enabled {
            let action = if enabled { "enable" } else { "disable" };
            let out = backend.execute("systemctl", &[action, &self.service]).await
                .context(format!("systemctl {} {}", action, self.service))?;
            output.push_str(&format!("systemctl {}: {}\n", action, out.stdout.trim()));
        }

        match self.state.as_str() {
            "started" => {
                let out = backend.execute("systemctl", &["start", &self.service]).await
                    .context(format!("systemctl start {}", self.service))?;
                output.push_str(&format!("systemctl start: {}\n", out.stdout.trim()));
            }
            "stopped" => {
                let out = backend.execute("systemctl", &["stop", &self.service]).await
                    .context(format!("systemctl stop {}", self.service))?;
                output.push_str(&format!("systemctl stop: {}\n", out.stdout.trim()));
            }
            "restarted" => {
                let out = backend.execute("systemctl", &["restart", &self.service]).await
                    .context(format!("systemctl restart {}", self.service))?;
                output.push_str(&format!("systemctl restart: {}\n", out.stdout.trim()));
            }
            "reloaded" => {
                let out = backend.execute("systemctl", &["reload", &self.service]).await
                    .context(format!("systemctl reload {}", self.service))?;
                output.push_str(&format!("systemctl reload: {}\n", out.stdout.trim()));
            }
            _ => {}
        }

        Ok(TaskResult {
            name: self.name.clone(),
            module: "systemd",
            changed: true,
            output: Some(output.trim().to_string()),
            error: None,
        })
    }
}
