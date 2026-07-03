pub mod backend;
pub mod module;
pub mod runner;
pub mod apt;
pub mod file;
pub mod systemd;
pub mod user;
#[cfg(feature = "docker")]
pub mod docker;

use std::collections::HashMap;
use anyhow::{Context, Result};
use serde_json::Value;
use module::TaskModule;
use runner::{Playbook, Task, Handler};

fn normalize_module(name: &str) -> &str {
    match name {
        "ansible.builtin.apt" | "apt" => "apt",
        "ansible.builtin.file" | "file" => "file",
        "ansible.builtin.systemd" | "ansible.builtin.systemd_service" | "systemd" => "systemd",
        "ansible.builtin.user" | "user" => "user",
        "community.docker.docker_container" | "docker_container" | "docker" => "docker",
        "command" | "ansible.builtin.command" | "shell" | "ansible.builtin.shell" => "command",
        _ => name,
    }
}

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
        #[cfg(feature = "docker")]
        reg.register("docker", |name, params| {
            docker::DockerModule::from_params(name, params).map(|m| Box::new(m) as _)
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
        let normalized = normalize_module(module_type);
        let factory = self.factories.get(normalized)
            .context(format!("unknown module type: '{}'", normalized))?;
        factory(name, params)
    }

    fn parse_handlers(&self, handlers_val: &[Value]) -> Result<Vec<Handler>> {
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
        Ok(handlers)
    }

    pub fn from_json_value(&self, playbook_value: &Value) -> Result<Playbook> {
        // Support Ansible-style: top-level is a list of plays
        if let Some(plays) = playbook_value.as_array() {
            if plays.is_empty() {
                return Ok(Playbook { name: "empty".into(), tasks: vec![], handlers: vec![] });
            }
            let first = &plays[0];
            return self.from_play(first);
        }
        self.from_play(playbook_value)
    }

    fn from_play(&self, play_value: &Value) -> Result<Playbook> {
        let name = play_value.get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("default")
            .to_string();

        // Merge vars into tasks
        let _vars = play_value.get("vars").cloned().unwrap_or(Value::Null);

        // Top-level become falls through to all tasks
        let play_use_become = play_value.get("use_become").and_then(|v| v.as_bool()).unwrap_or(false);
        let play_become_user = play_value.get("become_user").and_then(|v| v.as_str())
            .unwrap_or("root").to_string();

        let tasks_val = play_value.get("tasks")
            .or_else(|| play_value.get("pre_tasks"))
            .or_else(|| play_value.get("post_tasks"))
            .and_then(|v| v.as_array())
            .context("playbook: missing 'tasks' array")?;

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
            let use_become = obj.get("use_become").and_then(|v| v.as_bool()).unwrap_or(play_use_become);
            let task_become_user = obj.get("become_user").and_then(|v| v.as_str())
                .unwrap_or(&play_become_user).to_string();

            let module = self.create(module_type, task_name.clone(), &params)?;
            tasks.push(Task { module, notify, use_become, become_user: task_become_user });
        }

        let handlers_val = play_value.get("handlers")
            .and_then(|v| v.as_array())
            .map(|a| a.to_vec())
            .unwrap_or_default();
        let handlers = self.parse_handlers(&handlers_val)?;

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

    #[tokio::test]
    async fn test_parse_ansible_play() {
        let registry = ModuleRegistry::new();
        let json = r#"[
            {
                "name": "deploy",
                "hosts": "all",
                "use_become": true,
                "vars": {"pkg": "nginx"},
                "tasks": [
                    {
                        "name": "Install",
                        "module": "ansible.builtin.apt",
                        "name": "nginx",
                        "state": "present"
                    },
                    {
                        "name": "Config",
                        "module": "ansible.builtin.file",
                        "path": "/etc/nginx/nginx.conf",
                        "content": "server { }",
                        "use_become": false
                    }
                ]
            }
        ]"#;
        let pb = registry.from_json_str(json).expect("parse");
        assert_eq!(pb.name, "deploy");
        assert_eq!(pb.tasks.len(), 2);
        assert!(pb.tasks[0].use_become, "first task inherits play become");
        assert!(!pb.tasks[1].use_become, "second task overrides become: false");
        assert_eq!(pb.tasks[0].become_user, "root");
    }

    #[test]
    fn test_normalize_ansible_builtin() {
        assert_eq!(normalize_module("ansible.builtin.apt"), "apt");
        assert_eq!(normalize_module("ansible.builtin.file"), "file");
        assert_eq!(normalize_module("ansible.builtin.user"), "user");
        assert_eq!(normalize_module("community.docker.docker_container"), "docker");
        assert_eq!(normalize_module("apt"), "apt");
    }
}
