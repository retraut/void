use async_trait::async_trait;
use anyhow::Result;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use crate::engine::backend::SystemBackend;

#[derive(Debug, Clone, Serialize)]
pub struct TaskResult {
    pub name: String,
    pub module: &'static str,
    pub changed: bool,
    pub output: Option<String>,
    pub error: Option<String>,
}

#[async_trait]
pub trait TaskModule: Send + Sync {
    fn module_name(&self) -> &'static str;
    fn task_name(&self) -> &str;
    fn from_params(name: String, params: &HashMap<String, Value>) -> Result<Self>
    where
        Self: Sized;
    async fn check_state(&self, backend: &dyn SystemBackend) -> Result<bool>;
    async fn apply_changes(&self, backend: &dyn SystemBackend) -> Result<TaskResult>;
}
