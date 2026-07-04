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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use crate::engine::backend::{MockBackend, CommandOutput};

    fn mk(params: &[(&str, Value)]) -> SystemdModule {
        let mut m = HashMap::new();
        for (k, v) in params { m.insert(k.to_string(), v.clone()); }
        SystemdModule::from_params("test".into(), &m).expect("from_params")
    }
    fn val(v: &str) -> Value { Value::String(v.into()) }
    fn flag(v: bool) -> Value { Value::Bool(v) }

    #[test]
    fn test_from_params_minimal() {
        let m = mk(&[("service", val("nginx"))]);
        assert_eq!(m.service, "nginx");
        assert_eq!(m.state, "started");
    }

    #[test]
    fn test_from_params_all() {
        let m = mk(&[("service", val("nginx")), ("state", val("restarted")), ("enabled", flag(true)), ("daemon_reload", flag(true))]);
        assert_eq!(m.state, "restarted");
        assert_eq!(m.enabled, Some(true));
        assert!(m.daemon_reload);
    }

    #[tokio::test]
    async fn test_check_active() {
        let mock = MockBackend::new();
        mock.expect_exec("systemctl", &["is-active", "nginx"], CommandOutput { stdout: "active\n".into(), stderr: String::new(), exit_code: 0 });
        let backend: Arc<dyn SystemBackend> = Arc::new(mock);
        let m = mk(&[("service", val("nginx"))]);
        assert!(m.check_state(&*backend).await.unwrap());
    }

    #[tokio::test]
    async fn test_check_inactive() {
        let mock = MockBackend::new();
        mock.expect_exec("systemctl", &["is-active", "nginx"], CommandOutput { stdout: "inactive\n".into(), stderr: String::new(), exit_code: 3 });
        let backend: Arc<dyn SystemBackend> = Arc::new(mock);
        let m = mk(&[("service", val("nginx"))]);
        assert!(!m.check_state(&*backend).await.unwrap());
    }

    #[tokio::test]
    async fn test_check_enabled() {
        let mock = MockBackend::new();
        mock.expect_exec("systemctl", &["is-active", "nginx"], CommandOutput { stdout: "active\n".into(), stderr: String::new(), exit_code: 0 });
        mock.expect_exec("systemctl", &["is-enabled", "nginx"], CommandOutput { stdout: "enabled\n".into(), stderr: String::new(), exit_code: 0 });
        let backend: Arc<dyn SystemBackend> = Arc::new(mock);
        let m = mk(&[("service", val("nginx")), ("enabled", flag(true))]);
        assert!(m.check_state(&*backend).await.unwrap());
    }

    #[tokio::test]
    async fn test_check_not_enabled() {
        let mock = MockBackend::new();
        mock.expect_exec("systemctl", &["is-active", "nginx"], CommandOutput { stdout: "active\n".into(), stderr: String::new(), exit_code: 0 });
        mock.expect_exec("systemctl", &["is-enabled", "nginx"], CommandOutput { stdout: "disabled\n".into(), stderr: String::new(), exit_code: 1 });
        let backend: Arc<dyn SystemBackend> = Arc::new(mock);
        let m = mk(&[("service", val("nginx")), ("enabled", flag(true))]);
        assert!(!m.check_state(&*backend).await.unwrap());
    }

    #[tokio::test]
    async fn test_apply_start() {
        let mock = MockBackend::new();
        mock.expect_exec("systemctl", &["start", "nginx"], CommandOutput { stdout: String::new(), stderr: String::new(), exit_code: 0 });
        let backend: Arc<dyn SystemBackend> = Arc::new(mock);
        let m = mk(&[("service", val("nginx")), ("state", val("started"))]);
        let r = m.apply_changes(&*backend).await.unwrap();
        assert!(r.changed);
    }

    #[tokio::test]
    async fn test_apply_stop() {
        let mock = MockBackend::new();
        mock.expect_exec("systemctl", &["stop", "nginx"], CommandOutput { stdout: String::new(), stderr: String::new(), exit_code: 0 });
        let backend: Arc<dyn SystemBackend> = Arc::new(mock);
        let m = mk(&[("service", val("nginx")), ("state", val("stopped"))]);
        let r = m.apply_changes(&*backend).await.unwrap();
        assert!(r.changed);
    }

    #[tokio::test]
    async fn test_apply_restart() {
        let mock = MockBackend::new();
        mock.expect_exec("systemctl", &["restart", "nginx"], CommandOutput { stdout: String::new(), stderr: String::new(), exit_code: 0 });
        let backend: Arc<dyn SystemBackend> = Arc::new(mock);
        let m = mk(&[("service", val("nginx")), ("state", val("restarted"))]);
        let r = m.apply_changes(&*backend).await.unwrap();
        assert!(r.changed);
    }

    #[tokio::test]
    async fn test_apply_enable() {
        let mock = MockBackend::new();
        mock.expect_exec("systemctl", &["enable", "nginx"], CommandOutput { stdout: String::new(), stderr: String::new(), exit_code: 0 });
        mock.expect_exec("systemctl", &["start", "nginx"], CommandOutput { stdout: String::new(), stderr: String::new(), exit_code: 0 });
        let backend: Arc<dyn SystemBackend> = Arc::new(mock);
        let m = mk(&[("service", val("nginx")), ("enabled", flag(true)), ("state", val("started"))]);
        let r = m.apply_changes(&*backend).await.unwrap();
        assert!(r.changed);
    }

    #[tokio::test]
    async fn test_apply_daemon_reload() {
        let mock = MockBackend::new();
        mock.expect_exec("systemctl", &["daemon-reload"], CommandOutput { stdout: String::new(), stderr: String::new(), exit_code: 0 });
        mock.expect_exec("systemctl", &["start", "nginx"], CommandOutput { stdout: String::new(), stderr: String::new(), exit_code: 0 });
        let backend: Arc<dyn SystemBackend> = Arc::new(mock);
        let m = mk(&[("service", val("nginx")), ("daemon_reload", flag(true))]);
        let r = m.apply_changes(&*backend).await.unwrap();
        assert!(r.changed);
    }
}
