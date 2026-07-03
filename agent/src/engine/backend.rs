use async_trait::async_trait;
use anyhow::{Context, Result};
use sha2::{Sha256, Digest};
#[cfg(test)]
use std::collections::VecDeque;
#[cfg(test)]
use std::sync::Mutex;

#[derive(Debug, Clone)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

impl CommandOutput {
    pub fn success(&self) -> bool { self.exit_code == 0 }
}

#[derive(Debug, Clone)]
pub struct FileInfo {
    pub exists: bool,
    pub mode: Option<String>,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub sha256: Option<String>,
}

#[async_trait]
pub trait SystemBackend: Send + Sync {
    async fn execute(&self, cmd: &str, args: &[&str]) -> Result<CommandOutput>;
    async fn execute_with_env(&self, cmd: &str, args: &[&str], env: &[(&str, &str)]) -> Result<CommandOutput>;
    async fn read_file(&self, path: &str) -> Result<String>;
    async fn write_file(&self, path: &str, content: &str, mode: Option<&str>) -> Result<()>;
    async fn file_exists(&self, path: &str) -> bool;
    async fn remove_file(&self, path: &str) -> Result<()>;
    async fn sha256(&self, path: &str) -> Result<String>;
    async fn stat(&self, path: &str) -> Result<FileInfo>;
}

pub struct LocalBackend;

#[async_trait]
impl SystemBackend for LocalBackend {
    async fn execute(&self, cmd: &str, args: &[&str]) -> Result<CommandOutput> {
        let output = tokio::process::Command::new(cmd)
            .args(args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .await
            .context(format!("spawn {} {:?}", cmd, args))?;
        Ok(CommandOutput {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code().unwrap_or(-1),
        })
    }

    async fn execute_with_env(&self, cmd: &str, args: &[&str], env: &[(&str, &str)]) -> Result<CommandOutput> {
        let mut command = tokio::process::Command::new(cmd);
        command.args(args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        for (k, v) in env {
            command.env(k, v);
        }
        let output = command.output().await
            .context(format!("spawn {} {:?}", cmd, args))?;
        Ok(CommandOutput {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code().unwrap_or(-1),
        })
    }

    async fn read_file(&self, path: &str) -> Result<String> {
        tokio::fs::read_to_string(path)
            .await
            .context(format!("read {}", path))
    }

    async fn write_file(&self, path: &str, content: &str, mode: Option<&str>) -> Result<()> {
        if let Some(parent) = std::path::Path::new(path).parent() {
            tokio::fs::create_dir_all(parent).await
                .context(format!("mkdir {}", parent.display()))?;
        }
        tokio::fs::write(path, content).await
            .context(format!("write {}", path))?;
        if let Some(m) = mode {
            let mut perms = tokio::fs::metadata(path).await?.permissions();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode_val = u32::from_str_radix(m, 8)
                    .map_err(|_| anyhow::anyhow!("invalid mode: {}", m))?;
                perms.set_mode(mode_val);
                tokio::fs::set_permissions(path, perms).await?;
            }
        }
        Ok(())
    }

    async fn file_exists(&self, path: &str) -> bool {
        tokio::fs::try_exists(path).await.unwrap_or(false)
    }

    async fn remove_file(&self, path: &str) -> Result<()> {
        tokio::fs::remove_file(path).await
            .context(format!("remove {}", path))
    }

    async fn sha256(&self, path: &str) -> Result<String> {
        let data = tokio::fs::read(path).await
            .context(format!("read for sha256 {}", path))?;
        let mut hasher = Sha256::new();
        hasher.update(&data);
        Ok(hex::encode(hasher.finalize()))
    }

    async fn stat(&self, path: &str) -> Result<FileInfo> {
        let meta = match tokio::fs::metadata(path).await {
            Ok(m) => m,
            Err(_) => return Ok(FileInfo {
                exists: false, mode: None, owner: None, group: None, sha256: None,
            }),
        };
        let sha = self.sha256(path).await.ok();
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Ok(FileInfo {
                exists: true,
                mode: Some(format!("{:o}", meta.mode() & 0o777)),
                owner: Some(meta.uid().to_string()),
                group: Some(meta.gid().to_string()),
                sha256: sha,
            })
        }
        #[cfg(not(unix))]
        {
            Ok(FileInfo {
                exists: true,
                mode: Some("unknown".into()),
                owner: None,
                group: None,
                sha256: sha,
            })
        }
    }
}

#[cfg(test)]
pub struct MockBackend {
    commands: Mutex<VecDeque<MockCommand>>,
    files: Mutex<std::collections::HashMap<String, MockFile>>,
}

#[cfg(test)]
struct MockCommand {
    cmd: String,
    args: Vec<String>,
    output: CommandOutput,
}

#[cfg(test)]
struct MockFile {
    content: String,
    mode: Option<String>,
}

#[cfg(test)]
impl MockBackend {
    pub fn new() -> Self {
        Self {
            commands: Mutex::new(VecDeque::new()),
            files: Mutex::new(std::collections::HashMap::new()),
        }
    }

    pub fn expect_exec(&self, cmd: &str, args: &[&str], output: CommandOutput) {
        let mut q = self.commands.lock().unwrap();
        q.push_back(MockCommand {
            cmd: cmd.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            output,
        });
    }

    pub fn set_file(&self, path: &str, content: &str, mode: Option<&str>) {
        let mut f = self.files.lock().unwrap();
        f.insert(path.to_string(), MockFile {
            content: content.to_string(),
            mode: mode.map(|s| s.to_string()),
        });
    }
}

#[cfg(test)]
#[async_trait]
impl SystemBackend for MockBackend {
    async fn execute(&self, cmd: &str, args: &[&str]) -> Result<CommandOutput> {
        let mut q = self.commands.lock().unwrap();
        let expected = q.pop_front()
            .ok_or_else(|| anyhow::anyhow!("no more expected commands, got: {} {:?}", cmd, args))?;
        assert_eq!(expected.cmd, cmd, "command mismatch");
        assert_eq!(expected.args, args, "args mismatch");
        Ok(expected.output)
    }

    async fn execute_with_env(&self, cmd: &str, args: &[&str], _env: &[(&str, &str)]) -> Result<CommandOutput> {
        // For mock, env is ignored — just match cmd+args
        self.execute(cmd, args).await
    }

    async fn read_file(&self, path: &str) -> Result<String> {
        let f = self.files.lock().unwrap();
        f.get(path).map(|f| f.content.clone())
            .ok_or_else(|| anyhow::anyhow!("mock file not found: {}", path))
    }

    async fn write_file(&self, path: &str, content: &str, mode: Option<&str>) -> Result<()> {
        let mut f = self.files.lock().unwrap();
        f.insert(path.to_string(), MockFile {
            content: content.to_string(),
            mode: mode.map(|s| s.to_string()),
        });
        Ok(())
    }

    async fn file_exists(&self, path: &str) -> bool {
        self.files.lock().unwrap().contains_key(path)
    }

    async fn remove_file(&self, path: &str) -> Result<()> {
        self.files.lock().unwrap().remove(path);
        Ok(())
    }

    async fn sha256(&self, path: &str) -> Result<String> {
        let f = self.files.lock().unwrap();
        let content = f.get(path)
            .ok_or_else(|| anyhow::anyhow!("mock file not found: {}", path))?;
        let mut hasher = Sha256::new();
        hasher.update(content.content.as_bytes());
        Ok(hex::encode(hasher.finalize()))
    }

    async fn stat(&self, path: &str) -> Result<FileInfo> {
        let f = self.files.lock().unwrap();
        match f.get(path) {
            Some(file) => {
                let mut hasher = Sha256::new();
                hasher.update(file.content.as_bytes());
                Ok(FileInfo {
                    exists: true,
                    mode: file.mode.clone(),
                    owner: Some("0".into()),
                    group: Some("0".into()),
                    sha256: Some(hex::encode(hasher.finalize())),
                })
            }
            None => Ok(FileInfo {
                exists: false, mode: None, owner: None, group: None, sha256: None,
            }),
        }
    }
}
