use async_trait::async_trait;
use anyhow::{Context, Result};
use serde_json::Value;
use std::collections::HashMap;
use sha2::Digest;
use crate::engine::backend::SystemBackend;
use crate::engine::module::{TaskModule, TaskResult};

pub struct FileModule {
    name: String,
    path: String,
    content: Option<String>,
    template: Option<String>,
    vars: HashMap<String, String>,
    mode: Option<String>,
    owner: Option<String>,
    group: Option<String>,
    state: String,
}

impl FileModule {
    fn render_template(template: &str, vars: &HashMap<String, String>) -> String {
        let mut result = template.to_string();
        for (key, value) in vars {
            result = result.replace(&format!("{{{{ {} }}}}", key), value);
            result = result.replace(&format!("{{{{{}}}}}", key), value);
        }
        result
    }

    fn resolve_content(&self) -> String {
        match (&self.content, &self.template) {
            (Some(c), _) => c.clone(),
            (_, Some(t)) => Self::render_template(t, &self.vars),
            (None, None) => String::new(),
        }
    }

    fn diff(old: &str, new: &str) -> String {
        let old_lines: Vec<&str> = old.lines().collect();
        let new_lines: Vec<&str> = new.lines().collect();
        if old_lines == new_lines {
            return "(identical)".into();
        }
        let mut diff = String::new();
        let max = old_lines.len().max(new_lines.len());
        for i in 0..max {
            let o = old_lines.get(i).copied().unwrap_or("");
            let n = new_lines.get(i).copied().unwrap_or("");
            if o != n {
                if !o.is_empty() {
                    diff.push_str(&format!("-{}\n", o));
                }
                if !n.is_empty() {
                    diff.push_str(&format!("+{}\n", n));
                }
            } else {
                diff.push_str(&format!(" {}\n", o));
            }
        }
        diff
    }
}

#[async_trait]
impl TaskModule for FileModule {
    fn module_name(&self) -> &'static str { "file" }
    fn task_name(&self) -> &str { &self.name }

    fn from_params(name: String, params: &HashMap<String, Value>) -> Result<Self> {
        let path = params.get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("file: missing 'path'"))?
            .to_string();
        let content = params.get("content").and_then(|v| v.as_str()).map(|s| s.to_string());
        let template = params.get("template").and_then(|v| v.as_str()).map(|s| s.to_string());
        let vars = match params.get("vars") {
            Some(Value::Object(m)) => m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect(),
            _ => HashMap::new(),
        };
        let state = params.get("state").and_then(|v| v.as_str())
            .unwrap_or("present").to_string();
        let mode = params.get("mode").and_then(|v| v.as_str()).map(|s| s.to_string());
        let owner = params.get("owner").and_then(|v| v.as_str()).map(|s| s.to_string());
        let group = params.get("group").and_then(|v| v.as_str()).map(|s| s.to_string());

        Ok(FileModule { name, path, content, template, vars, mode, owner, group, state })
    }

    async fn check_state(&self, backend: &dyn SystemBackend) -> Result<bool> {
        let info = backend.stat(&self.path).await?;
        if !info.exists {
            return Ok(self.state == "absent");
        }
        if self.state == "absent" {
            return Ok(false);
        }
        if let Some(ref content) = self.content {
            let current_sha = backend.sha256(&self.path).await?;
            let mut hasher = sha2::Sha256::new();
            hasher.update(content.as_bytes());
            let desired_sha = format!("{:x}", hasher.finalize());
            if current_sha != desired_sha {
                return Ok(false);
            }
        }
        if let (Some(ref desired_mode), Some(ref current_mode)) = (&self.mode, &info.mode) {
            if desired_mode != current_mode {
                return Ok(false);
            }
        }
        Ok(true)
    }

    async fn apply_changes(&self, backend: &dyn SystemBackend) -> Result<TaskResult> {
        if self.state == "absent" {
            backend.remove_file(&self.path).await?;
            return Ok(TaskResult {
                name: self.name.clone(),
                module: "file",
                changed: true,
                output: Some(format!("removed {}", self.path)),
                error: None,
            });
        }

        let before = backend.read_file(&self.path).await.unwrap_or_default();
        let content = self.resolve_content();
        let diff_output = Self::diff(&before, &content);

        backend.write_file(&self.path, &content, self.mode.as_deref()).await
            .context(format!("write {}", self.path))?;

        Ok(TaskResult {
            name: self.name.clone(),
            module: "file",
            changed: before != content,
            output: Some(if before != content {
                format!("updated {}:\n{}", self.path, diff_output)
            } else {
                format!("{} unchanged", self.path)
            }),
            error: None,
        })
    }
}
