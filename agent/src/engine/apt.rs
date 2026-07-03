use async_trait::async_trait;
use anyhow::{Context, Result};
use serde_json::Value;
use std::collections::HashMap;
use tracing::info;
use crate::engine::backend::SystemBackend;
use crate::engine::module::{TaskModule, TaskResult};

pub struct AptModule {
    name: String,
    packages: Vec<String>,
    state: String,
}

impl AptModule {
    fn extract_string(param: &HashMap<String, Value>, key: &str) -> Option<String> {
        param.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
    }
}

#[async_trait]
impl TaskModule for AptModule {
    fn module_name(&self) -> &'static str { "apt" }
    fn task_name(&self) -> &str { &self.name }

    fn from_params(name: String, params: &HashMap<String, Value>) -> Result<Self> {
        let packages = match params.get("packages") {
            Some(Value::Array(arr)) => {
                arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()
            }
            Some(Value::String(s)) => vec![s.clone()],
            _ => return Err(anyhow::anyhow!("apt: missing or invalid 'packages' field")),
        };
        if packages.is_empty() {
            return Err(anyhow::anyhow!("apt: 'packages' list is empty"));
        }
        let state = Self::extract_string(params, "state").unwrap_or_else(|| "present".into());
        if state != "present" && state != "absent" {
            return Err(anyhow::anyhow!("apt: state must be 'present' or 'absent', got '{}'", state));
        }
        Ok(AptModule { name, packages, state })
    }

    async fn check_state(&self, backend: &dyn SystemBackend) -> Result<bool> {
        for pkg in &self.packages {
            let out = backend.execute("dpkg-query", &["-W", "-f=${db:Status-Status}", pkg]).await
                .context(format!("dpkg-query for {}", pkg))?;
            let installed = out.stdout.trim() == "installed";
            match (installed, self.state.as_str()) {
                (true, "present") => continue,
                (false, "absent") => continue,
                _ => return Ok(false),
            }
        }
        Ok(true)
    }

    async fn apply_changes(&self, backend: &dyn SystemBackend) -> Result<TaskResult> {
        let action = match self.state.as_str() {
            "present" => "install",
            "absent" => "remove",
            _ => "install",
        };

        info!(packages = ?self.packages, action, "apt: applying");

        let success;
        let output;
        if self.state == "present" {
            let env = [("DEBIAN_FRONTEND", "noninteractive")];
            let mut apt_args = vec!["install".to_string(), "-y".to_string(), "--no-install-recommends".to_string()];
            apt_args.extend(self.packages.clone());
            let refs: Vec<&str> = apt_args.iter().map(|s| s.as_str()).collect();
            let out = backend.execute_with_env("apt-get", &refs, &env).await
                .context(format!("apt-get install {:?} failed", self.packages))?;
            success = out.success();
            output = (out.stdout, out.stderr);
        } else {
            let mut apt_args = vec!["remove".to_string(), "-y".to_string()];
            apt_args.extend(self.packages.clone());
            let refs: Vec<&str> = apt_args.iter().map(|s| s.as_str()).collect();
            let out = backend.execute_with_env("apt-get", &refs, &[]).await
                .context(format!("apt-get remove {:?} failed", self.packages))?;
            success = out.success();
            output = (out.stdout, out.stderr);
        }

        Ok(TaskResult {
            name: self.name.clone(),
            module: "apt",
            changed: true,
            output: Some(output.0),
            error: if !success { Some(output.1) } else { None },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use crate::engine::backend::{MockBackend, SystemBackend, CommandOutput};

    #[tokio::test]
    async fn test_apt_check_installed() {
        let mock_backend = MockBackend::new();
        mock_backend.expect_exec("dpkg-query", &["-W", "-f=${db:Status-Status}", "nginx"], CommandOutput {
            stdout: "installed".into(),
            stderr: String::new(),
            exit_code: 0,
        });
        let mock: Arc<dyn SystemBackend> = Arc::new(mock_backend);

        let module = AptModule {
            name: "test".into(),
            packages: vec!["nginx".into()],
            state: "present".into(),
        };

        let result = module.check_state(&*mock).await.expect("check_state");
        assert!(result, "nginx should be reported as installed");
    }

    #[tokio::test]
    async fn test_apt_check_missing() {
        let mock_backend = MockBackend::new();
        mock_backend.expect_exec("dpkg-query", &["-W", "-f=${db:Status-Status}", "nginx"], CommandOutput {
            stdout: "not-installed".into(),
            stderr: String::new(),
            exit_code: 1,
        });
        let mock: Arc<dyn SystemBackend> = Arc::new(mock_backend);

        let module = AptModule {
            name: "test".into(),
            packages: vec!["nginx".into()],
            state: "present".into(),
        };

        let result = module.check_state(&*mock).await.expect("check_state");
        assert!(!result, "nginx should be reported as missing");
    }
}
