pub mod backend;
pub mod module;
pub mod runner;
pub mod apt;
pub mod file;
pub mod systemd;
pub mod user;

use std::collections::HashMap;
use anyhow::{Context, Result};
use serde_json::Value;
use module::TaskModule;
use runner::{Playbook, Task, Handler};

pub struct ModuleRegistry {
    factories: HashMap<&'static str, Box<dyn Fn(String, &HashMap<String, Value>) -> Result<Box<dyn TaskModule>> + Send + Sync>>,
}

impl ModuleRegistry {
    pub fn new() -> Self {
        let mut reg = Self { factories: HashMap::new() };
        reg.register("apt", |name, params| {
            apt::AptModule::from_params(name, params).map(|m| Box::new(m) as _)
        });
        reg.register("file", |name, params| {
            file::FileModule::from_params(name, params).map(|m| Box::new(m) as _)
        });
        reg.register("systemd", |name, params| {
            systemd::SystemdModule::from_params(name, params).map(|m| Box::new(m) as _)
        });
        reg.register("user", |name, params| {
            user::UserModule::from_params(name, params).map(|m| Box::new(m) as _)
        });
        reg
    }

    fn register(
        &mut self,
        name: &'static str,
        factory: impl Fn(String, &HashMap<String, Value>) -> Result<Box<dyn TaskModule>> + Send + Sync + 'static,
    ) {
        self.factories.insert(name, Box::new(factory));
    }

    pub fn create(&self, module_type: &str, name: String, params: &HashMap<String, Value>) -> Result<Box<dyn TaskModule>> {
        let factory = self.factories.get(module_type)
            .context(format!("unknown module type: '{}'", module_type))?;
        factory(name, params)
    }

    pub fn from_json_value(&self, playbook_value: &Value) -> Result<Playbook> {
        let name = playbook_value.get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("default")
            .to_string();

        let tasks_val = playbook_value.get("tasks")
            .and_then(|v| v.as_array())
            .context("playbook: missing or invalid 'tasks' array")?;

        let mut tasks = Vec::new();
        for (i, tv) in tasks_val.iter().enumerate() {
            let obj = tv.as_object()
                .ok_or_else(|| anyhow::anyhow!("task {}: expected object", i))?;
            let params: HashMap<String, Value> = obj.clone().into_iter().collect();
            let module_type = obj.get("module")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("task {}: missing 'module' field", i))?;
            let task_name = obj.get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(module_type)
                .to_string();
            let notify = match obj.get("notify") {
                Some(Value::Array(arr)) => {
                    arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()
                }
                _ => vec![],
            };

            let module = self.create(module_type, task_name.clone(), &params)?;
            tasks.push(Task { module, notify });
        }

        let handlers_val = playbook_value.get("handlers")
            .and_then(|v| v.as_array())
            .map(|a| a.to_vec())
            .unwrap_or_default();

        let mut handlers = Vec::new();
        for (i, hv) in handlers_val.iter().enumerate() {
            let obj = hv.as_object()
                .ok_or_else(|| anyhow::anyhow!("handler {}: expected object", i))?;
            let params: HashMap<String, Value> = obj.clone().into_iter().collect();
            let module_type = obj.get("module")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("handler {}: missing 'module' field", i))?;
            let handler_name = obj.get("name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("handler {}: missing 'name' field", i))?
                .to_string();

            let module = self.create(module_type, handler_name.clone(), &params)?;
            handlers.push(Handler { name: handler_name, module });
        }

        Ok(Playbook { name, tasks, handlers })
    }

    pub fn from_json_str(&self, json: &str) -> Result<Playbook> {
        let value: Value = serde_json::from_str(json)
            .context("playbook: invalid JSON")?;
        self.from_json_value(&value)
    }
}

impl Default for ModuleRegistry {
    fn default() -> Self { Self::new() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::backend::{MockBackend, SystemBackend};
    use crate::engine::runner::{Runner, RunMode};
    use std::sync::Arc;

    #[tokio::test]
    async fn test_empty_playbook() {
        let registry = ModuleRegistry::new();
        let json = r#"{"name": "test", "tasks": []}"#;
        let pb = registry.from_json_str(json).expect("parse");
        assert_eq!(pb.name, "test");
        assert!(pb.tasks.is_empty());
    }

    #[tokio::test]
    async fn test_full_pipeline() {
        let registry = ModuleRegistry::new();
        let json = r#"{
            "name": "test-pipeline",
            "tasks": [
                {
                    "name": "Write config",
                    "module": "file",
                    "path": "/tmp/test.conf",
                    "content": "hello world",
                    "mode": "0644",
                    "notify": ["restart service"]
                }
            ],
            "handlers": [
                {
                    "name": "restart service",
                    "module": "systemd",
                    "service": "test-service",
                    "state": "restarted"
                }
            ]
        }"#;

        let pb = registry.from_json_str(json).expect("parse");
        assert_eq!(pb.tasks.len(), 1);
        assert_eq!(pb.handlers.len(), 1);
        assert_eq!(pb.handlers[0].name, "restart service");

        let mock = Arc::new(MockBackend::new()) as Arc<dyn SystemBackend>;
        let runner = Runner::new(mock);

        let result = runner.run(&pb, RunMode::Check).await;
        assert_eq!(result.tasks.len(), 1);
        assert_eq!(result.mode, RunMode::Check);
    }
}
