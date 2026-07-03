use async_trait::async_trait;
use anyhow::{Context, Result};
use serde_json::Value;
use std::collections::HashMap;

use crate::engine::backend::SystemBackend;
use crate::engine::module::{TaskModule, TaskResult};

pub struct UserModule {
    name: String,
    username: String,
    state: String,
    shell: Option<String>,
    home: Option<String>,
    groups: Vec<String>,
    uid: Option<u32>,
    ssh_keys: Vec<String>,
    password: Option<String>,
}

#[async_trait]
impl TaskModule for UserModule {
    fn module_name(&self) -> &'static str { "user" }
    fn task_name(&self) -> &str { &self.name }

    fn from_params(name: String, params: &HashMap<String, Value>) -> Result<Self> {
        let username = params.get("username").or_else(|| params.get("name"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("user: missing 'username'"))?
            .to_string();
        let state = params.get("state").and_then(|v| v.as_str()).unwrap_or("present").to_string();
        let shell = params.get("shell").and_then(|v| v.as_str()).map(|s| s.to_string());
        let home = params.get("home").and_then(|v| v.as_str()).map(|s| s.to_string());
        let groups = match params.get("groups") {
            Some(Value::Array(arr)) => {
                arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()
            }
            Some(Value::String(s)) => vec![s.clone()],
            _ => vec![],
        };
        let uid = params.get("uid").and_then(|v| v.as_u64()).map(|u| u as u32);
        let ssh_keys = match params.get("ssh_keys").or_else(|| params.get("ssh_authorized_keys")) {
            Some(Value::Array(arr)) => {
                arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()
            }
            _ => vec![],
        };
        let password = params.get("password").and_then(|v| v.as_str()).map(|s| s.to_string());

        Ok(UserModule { name, username, state, shell, home, groups, uid, ssh_keys, password })
    }

    async fn check_state(&self, backend: &dyn SystemBackend) -> Result<bool> {
        let out = backend.execute("id", &["-u", &self.username]).await;
        let exists = out.map(|o| o.success()).unwrap_or(false);

        if !exists {
            return Ok(self.state == "absent");
        }
        if self.state == "absent" {
            return Ok(false);
        }

        // Check shell
        if let Some(ref shell) = self.shell {
            let out = backend.execute("getent", &["passwd", &self.username]).await?;
            let current_shell = out.stdout.trim().split(':').nth(6).unwrap_or("");
            if current_shell != shell.as_str() {
                return Ok(false);
            }
        }

        // Check groups
        if !self.groups.is_empty() {
            let out = backend.execute("groups", &[&self.username]).await?;
            let current_groups: Vec<&str> = out.stdout.trim()
                .split(':').nth(1).unwrap_or("")
                .split_whitespace().collect();
            for g in &self.groups {
                if !current_groups.contains(&g.as_str()) {
                    return Ok(false);
                }
            }
        }

        // Check SSH keys
        if !self.ssh_keys.is_empty() {
            let ssh_dir = format!("/home/{}/.ssh", self.username);
            let auth_keys = format!("{}/authorized_keys", ssh_dir);
            if let Ok(content) = backend.read_file(&auth_keys).await {
                for key in &self.ssh_keys {
                    if !content.contains(key) {
                        return Ok(false);
                    }
                }
            } else {
                return Ok(false);
            }
        }

        Ok(true)
    }

    async fn apply_changes(&self, backend: &dyn SystemBackend) -> Result<TaskResult> {
        let out = backend.execute("id", &["-u", &self.username]).await;
        let exists = out.map(|o| o.success()).unwrap_or(false);
        let mut output = String::new();
        let mut changed = false;

        if self.state == "absent" {
            if exists {
                backend.execute("userdel", &["-r", &self.username]).await
                    .context(format!("userdel {}", self.username))?;
                output.push_str(&format!("removed user {}\n", self.username));
                changed = true;
            }
            return Ok(TaskResult {
                name: self.name.clone(),
                module: "user",
                changed,
                output: Some(output.trim().to_string()),
                error: None,
            });
        }

        if !exists {
            let mut args = vec!["-m".to_string()];
            if let Some(ref shell) = self.shell {
                args.push("-s".into());
                args.push(shell.clone());
            }
            if let Some(ref home) = self.home {
                args.push("-d".into());
                args.push(home.clone());
            }
            if let Some(uid) = self.uid {
                args.push("-u".into());
                args.push(uid.to_string());
            }
            if !self.groups.is_empty() {
                args.push("-G".into());
                args.push(self.groups.join(","));
            }
            args.push(self.username.clone());

            let args_str: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            backend.execute("useradd", &args_str).await
                .context(format!("useradd {}", self.username))?;
            output.push_str(&format!("created user {}\n", self.username));
            changed = true;
        } else {
            // Modify existing user
            if let Some(ref shell) = self.shell {
                backend.execute("chsh", &["-s", shell, &self.username]).await?;
                output.push_str(&format!("changed shell for {}\n", self.username));
                changed = true;
            }
            if !self.groups.is_empty() {
                let groups_str = self.groups.join(",");
                backend.execute("usermod", &["-aG", &groups_str, &self.username]).await?;
                output.push_str(&format!("added {} to groups: {}\n", self.username, groups_str));
                changed = true;
            }
        }

        // Write SSH keys
        if !self.ssh_keys.is_empty() {
            let home_dir = self.home.clone().unwrap_or_else(|| format!("/home/{}", self.username));
            let ssh_dir = format!("{}/.ssh", home_dir);
            let auth_keys = format!("{}/authorized_keys", ssh_dir);
            let existing = backend.read_file(&auth_keys).await.unwrap_or_default();
            let mut all_keys = existing.clone();
            for key in &self.ssh_keys {
                if !all_keys.contains(key) {
                    all_keys.push_str(key);
                    all_keys.push('\n');
                }
            }
            if all_keys != existing {
                backend.execute("mkdir", &["-p", &ssh_dir]).await?;
                backend.write_file(&auth_keys, &all_keys, Some("0600")).await
                    .context(format!("write {}", auth_keys))?;
                backend.execute("chown", &["-R", &format!("{}:{}", self.username, self.username), &ssh_dir]).await?;
                output.push_str(&format!("wrote {} SSH keys\n", self.ssh_keys.len()));
                changed = true;
            }
        }

        Ok(TaskResult {
            name: self.name.clone(),
            module: "user",
            changed,
            output: Some(output.trim().to_string()),
            error: None,
        })
    }
}
