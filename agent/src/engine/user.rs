use async_trait::async_trait;
use anyhow::Result;
use serde_json::Value;
use std::collections::HashMap;
use crate::engine::backend::SystemBackend;
use crate::engine::module::{TaskModule, TaskResult};

pub struct UserModule {
    name: String,
    username: String,
    state: String,
    uid: Option<u32>,
    comment: Option<String>,
    shell: Option<String>,
    home: Option<String>,
    create_home: bool,
    move_home: bool,
    skeleton: Option<String>,
    group: Option<String>,
    groups: Vec<String>,
    append: bool,
    password: Option<String>,
    update_password: String,
    system: bool,
    force: bool,
    remove: bool,
    expires: Option<i64>,
    password_lock: Option<bool>,
    generate_ssh_key: bool,
    ssh_key_bits: Option<u32>,
    ssh_key_type: String,
    ssh_key_file: Option<String>,
    ssh_key_comment: Option<String>,
    ssh_key_passphrase: Option<String>,
    password_expire_max: Option<i32>,
    password_expire_min: Option<i32>,
    password_expire_warn: Option<i32>,
    inactive: Option<i32>,
    non_unique: bool,
    ssh_keys: Vec<String>,
}

fn val_str<'a>(p: &'a HashMap<String, Value>, key: &str) -> Option<&'a str> {
    p.get(key).and_then(|v| v.as_str())
}
fn val_u64(p: &HashMap<String, Value>, key: &str) -> Option<u64> {
    p.get(key).and_then(|v| v.as_u64())
}
fn val_i64(p: &HashMap<String, Value>, key: &str) -> Option<i64> {
    p.get(key).and_then(|v| v.as_i64())
}
fn val_bool(p: &HashMap<String, Value>, key: &str) -> Option<bool> {
    p.get(key).and_then(|v| v.as_bool())
}
fn str_list(p: &HashMap<String, Value>, key: &str) -> Vec<String> {
    match p.get(key) {
        Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
        Some(Value::String(s)) => s.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
        _ => vec![],
    }
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
        let state = val_str(params, "state").unwrap_or("present").to_string();
        let uid = val_u64(params, "uid").map(|u| u as u32);
        let comment = val_str(params, "comment").or_else(|| val_str(params, "description")).map(String::from);
        let shell = val_str(params, "shell").map(String::from);
        let home = val_str(params, "home").map(String::from);
        let create_home = val_bool(params, "create_home").or_else(|| val_bool(params, "createhome")).unwrap_or(true);
        let move_home = val_bool(params, "move_home").unwrap_or(false);
        let skeleton = val_str(params, "skeleton").map(String::from);
        let group = val_str(params, "group").map(String::from);
        let groups = str_list(params, "groups");
        let append = val_bool(params, "append").unwrap_or(false);
        let password = val_str(params, "password").map(String::from);
        let update_password = val_str(params, "update_password").unwrap_or("always").to_string();
        let system = val_bool(params, "system").unwrap_or(false);
        let force = val_bool(params, "force").unwrap_or(false);
        let remove = val_bool(params, "remove").unwrap_or(false);
        let expires = val_i64(params, "expires");
        let password_lock = val_bool(params, "password_lock");
        let generate_ssh_key = val_bool(params, "generate_ssh_key").unwrap_or(false);
        let ssh_key_bits = val_u64(params, "ssh_key_bits").map(|u| u as u32);
        let ssh_key_type = val_str(params, "ssh_key_type").unwrap_or("rsa").to_string();
        let ssh_key_file = val_str(params, "ssh_key_file").map(String::from);
        let ssh_key_comment = val_str(params, "ssh_key_comment").map(String::from).or_else(|| Some("ansible-generated".to_string()));
        let ssh_key_passphrase = val_str(params, "ssh_key_passphrase").map(String::from);
        let password_expire_max = val_i64(params, "password_expire_max").map(|v| v as i32);
        let password_expire_min = val_i64(params, "password_expire_min").map(|v| v as i32);
        let password_expire_warn = val_i64(params, "password_expire_warn").map(|v| v as i32);
        let inactive = val_i64(params, "password_expire_account_disable").map(|v| v as i32);
        let non_unique = val_bool(params, "non_unique").unwrap_or(false);
        let ssh_keys = {
            let k = str_list(params, "ssh_keys");
            if !k.is_empty() { k } else { str_list(params, "ssh_authorized_keys") }
        };

        Ok(UserModule {
            name, username, state, uid, comment, shell, home, create_home, move_home, skeleton,
            group, groups, append, password, update_password, system, force, remove, expires,
            password_lock, generate_ssh_key, ssh_key_bits, ssh_key_type, ssh_key_file,
            ssh_key_comment, ssh_key_passphrase, password_expire_max, password_expire_min,
            password_expire_warn, inactive, non_unique, ssh_keys,
        })
    }

    async fn check_state(&self, backend: &dyn SystemBackend) -> Result<bool> {
        let exists = self.user_exists(backend).await;
        if self.state == "absent" { return Ok(!exists); }
        if !exists { return Ok(false); }

        let info = self.getent_passwd(backend).await;
        let pw = info.as_ref();

        if let Some(uid) = self.uid {
            if pw.and_then(|f| f.get(2)).and_then(|s| s.parse::<u32>().ok()) != Some(uid) { return Ok(false); }
        }
        if let Some(ref comment) = self.comment {
            if pw.map(|f| f.get(4).map(|s| s.as_str())).flatten() != Some(comment.as_str()) { return Ok(false); }
        }
        if let Some(ref shell) = self.shell {
            if pw.map(|f| f.get(6).map(|s| s.as_str())).flatten() != Some(shell.as_str()) { return Ok(false); }
        }
        if let Some(ref home) = self.home {
            if pw.map(|f| f.get(5).map(|s| s.as_str())).flatten() != Some(home.as_str()) { return Ok(false); }
        }
        if let Some(ref group) = self.group {
            let gid = self.resolve_group(backend, group).await;
            if pw.map(|f| f.get(3).and_then(|s| s.parse::<u32>().ok())).flatten() != gid { return Ok(false); }
        }
        if !self.groups.is_empty() {
            let ug = self.user_groups(backend).await;
            for g in &self.groups { if !ug.contains(g) { return Ok(false); } }
        }
        if !self.ssh_keys.is_empty() {
            let keys = self.read_ssh_keys(backend).await;
            for key in &self.ssh_keys { if !keys.iter().any(|k| k == key.trim()) { return Ok(false); } }
        }
        Ok(true)
    }

    async fn apply_changes(&self, backend: &dyn SystemBackend) -> Result<TaskResult> {
        let exists = self.user_exists(backend).await;
        let mut output = String::new();
        let mut changed = false;

        if self.state == "absent" {
            if !exists {
                return Ok(TaskResult { name: self.name.clone(), module: "user", changed: false, output: Some("already absent".into()), error: None });
            }
            let mut args = vec!["-f".to_string()];
            if self.remove { args.push("-r".to_string()); }
            args.push(self.username.clone());
            let r: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            backend.execute("userdel", &r).await?;
            output.push_str(&format!("removed user {}", self.username));
            return Ok(TaskResult { name: self.name.clone(), module: "user", changed: true, output: Some(output), error: None });
        }

        if !exists {
            let mut args = vec![];
            if self.system { args.push("--system".to_string()); }
            if let Some(uid) = self.uid {
                args.push("-u".into()); args.push(uid.to_string());
                if self.non_unique { args.push("-o".into()); }
            }
            if let Some(ref g) = self.group { args.push("-g".into()); args.push(g.clone()); }
            if !self.groups.is_empty() {
                args.push("-G".into()); args.push(self.groups.join(","));
            }
            if let Some(ref c) = self.comment { args.push("-c".into()); args.push(c.clone()); }
            if let Some(ref h) = self.home { args.push("-d".into()); args.push(h.clone()); }
            if let Some(ref s) = self.shell { args.push("-s".into()); args.push(s.clone()); }
            if self.create_home { args.push("-m".into()); }
            if !self.create_home { args.push("-M".into()); }
            if let Some(ref skel) = self.skeleton { args.push("-k".into()); args.push(skel.clone()); }
            args.push(self.username.clone());
            let r: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            backend.execute("useradd", &r).await?;
            output.push_str(&format!("created user {}\n", self.username));
            changed = true;
        } else {
            // Modify existing user
            let mut mod_args = vec![];
            if let Some(uid) = self.uid { mod_args.push("-u".into()); mod_args.push(uid.to_string()); }
            if let Some(ref g) = self.group { mod_args.push("-g".into()); mod_args.push(g.clone()); }
            if let Some(ref h) = self.home {
                mod_args.push("-d".into()); mod_args.push(h.clone());
                if self.move_home { mod_args.push("-m".into()); }
            }
            if let Some(ref s) = self.shell { mod_args.push("-s".into()); mod_args.push(s.clone()); }
            if let Some(ref c) = self.comment { mod_args.push("-c".into()); mod_args.push(c.clone()); }
            if !mod_args.is_empty() {
                mod_args.push(self.username.clone());
                let r: Vec<&str> = mod_args.iter().map(|s| s.as_str()).collect();
                backend.execute("usermod", &r).await?;
                output.push_str("modified user attributes\n");
                changed = true;
            }
            // Groups with usermod
            if !self.groups.is_empty() {
                let groups_str = self.groups.join(",");
                if self.append {
                    let r = vec!["-aG", groups_str.as_str(), &self.username];
                    backend.execute("usermod", &r).await?;
                } else {
                    let r = vec!["-G", groups_str.as_str(), &self.username];
                    backend.execute("usermod", &r).await?;
                }
                output.push_str(&format!("modified groups: {}\n", self.groups.join(",")));
                changed = true;
            }
        }

        // Password
        if let Some(ref pw) = self.password {
            let set = self.update_password == "always" || (self.update_password == "on_create" && !exists);
            if set {
                let pw = if self.password_lock == Some(true) { format!("!{}", pw) } else { pw.clone() };
                let echo_str = format!("{}:{}", self.username, pw);
                let mut cmd = tokio::process::Command::new("chpasswd");
                cmd.stdin(std::process::Stdio::piped());
                if let Ok(mut child) = cmd.spawn() {
                    use tokio::io::AsyncWriteExt;
                    if let Some(stdin) = child.stdin.as_mut() {
                        let _ = stdin.write_all(echo_str.as_bytes()).await;
                    }
                    let _ = child.wait().await;
                }
                output.push_str("password updated\n");
                changed = true;
            }
        } else if self.password_lock == Some(true) {
            backend.execute("passwd", &["-l", &self.username]).await?;
            output.push_str("password locked\n");
            changed = true;
        } else if self.password_lock == Some(false) {
            backend.execute("passwd", &["-u", &self.username]).await?;
            output.push_str("password unlocked\n");
            changed = true;
        }

        // Expiry
        if let Some(exp) = self.expires {
            let exp_str = if exp < 0 { "".into() } else { exp.to_string() };
            backend.execute("chage", &["-E", &exp_str, &self.username]).await?;
            output.push_str(&format!("expiry set to {}\n", exp));
            changed = true;
        }

        // Password expiry
        if self.password_expire_max.is_some() || self.password_expire_min.is_some() || self.password_expire_warn.is_some() {
            let mut ca = vec!["chage".to_string()];
            if let Some(v) = self.password_expire_min { ca.push("-m".into()); ca.push(v.to_string()); }
            if let Some(v) = self.password_expire_max { ca.push("-M".into()); ca.push(v.to_string()); }
            if let Some(v) = self.password_expire_warn { ca.push("-W".into()); ca.push(v.to_string()); }
            ca.push(self.username.clone());
            let r: Vec<&str> = ca.iter().map(|s| s.as_str()).collect();
            backend.execute("chage", &r[1..]).await?;
            output.push_str("password expiry set\n");
            changed = true;
        }

        // Inactive days
        if let Some(inactive) = self.inactive {
            backend.execute("usermod", &["-f", &inactive.to_string(), &self.username]).await?;
            output.push_str(&format!("inactive days set to {}\n", inactive));
            changed = true;
        }

        // SSH key generation
        if self.generate_ssh_key {
            let home_dir = self.home.clone().unwrap_or_else(|| format!("/home/{}", self.username));
            let key_file = self.ssh_key_file.clone().unwrap_or_else(|| format!(".ssh/id_{}", self.ssh_key_type));
            let key_path = if key_file.starts_with('/') { key_file.clone() } else { format!("{}/{}", home_dir, key_file) };
            let exists = backend.file_exists(&key_path).await;
            if !exists || self.force {
                let mut args = vec!["-t".to_string(), self.ssh_key_type.clone()];
                if let Some(bits) = self.ssh_key_bits {
                    args.push("-b".into()); args.push(bits.to_string());
                }
                if let Some(ref comment) = self.ssh_key_comment {
                    args.push("-C".into()); args.push(comment.clone());
                }
                args.push("-f".into()); args.push(key_path.clone());
                if self.ssh_key_passphrase.is_none() {
                    args.push("-N".into()); args.push("".into());
                }
                let r: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
                backend.execute("ssh-keygen", &r).await?;
                output.push_str("SSH key generated\n");
                changed = true;
            }
        }

        // SSH authorized keys
        if !self.ssh_keys.is_empty() {
            let home_dir = self.home.clone().unwrap_or_else(|| format!("/home/{}", self.username));
            let ssh_dir = format!("{}/.ssh", home_dir);
            let auth_keys = format!("{}/authorized_keys", ssh_dir);
            backend.execute("mkdir", &["-p", &ssh_dir]).await?;
            let existing = backend.read_file(&auth_keys).await.unwrap_or_default();
            let mut all = existing.clone();
            for key in &self.ssh_keys {
                let k = key.trim();
                if !all.contains(k) {
                    all.push_str(k); all.push('\n');
                }
            }
            if all != existing {
                backend.write_file(&auth_keys, &all, Some("0600")).await?;
                backend.execute("chown", &["-R", &format!("{}:{}", self.username, self.username), &ssh_dir]).await?;
                output.push_str("SSH authorized_keys updated\n");
                changed = true;
            }
        }

        Ok(TaskResult { name: self.name.clone(), module: "user", changed, output: Some(output.trim().into()), error: None })
    }
}

impl UserModule {
    async fn user_exists(&self, backend: &dyn SystemBackend) -> bool {
        backend.execute("id", &["-u", &self.username]).await.map(|o| o.success()).unwrap_or(false)
    }

    async fn getent_passwd(&self, backend: &dyn SystemBackend) -> Option<Vec<String>> {
        let out = backend.execute("getent", &["passwd", &self.username]).await.ok()?;
        Some(out.stdout.trim().split(':').map(String::from).collect())
    }

    async fn resolve_group(&self, backend: &dyn SystemBackend, group: &str) -> Option<u32> {
        if let Ok(gid) = group.parse::<u32>() { return Some(gid); }
        let out = backend.execute("getent", &["group", group]).await.ok()?;
        let gid_str = out.stdout.split(':').nth(2)?;
        gid_str.trim().parse::<u32>().ok()
    }

    async fn user_groups(&self, backend: &dyn SystemBackend) -> Vec<String> {
        let out = backend.execute("groups", &[&self.username]).await.ok();
        match out {
            Some(o) => o.stdout.split(':').nth(1).unwrap_or("")
                .split_whitespace().map(String::from).collect(),
            None => vec![],
        }
    }

    async fn read_ssh_keys(&self, backend: &dyn SystemBackend) -> Vec<String> {
        let home = self.home.clone().unwrap_or_else(|| format!("/home/{}", self.username));
        let path = format!("{}/.ssh/authorized_keys", home);
        backend.read_file(&path).await.unwrap_or_default()
            .lines().filter(|l| !l.is_empty() && !l.starts_with('#')).map(String::from).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use crate::engine::backend::{MockBackend, CommandOutput};

    fn mk(params: &[(&str, Value)]) -> UserModule {
        let mut m = HashMap::new();
        for (k, v) in params { m.insert(k.to_string(), v.clone()); }
        UserModule::from_params("test".into(), &m).expect("from_params")
    }
    fn s(v: &str) -> Value { Value::String(v.into()) }
    fn b(v: bool) -> Value { Value::Bool(v) }
    fn n(v: u64) -> Value { Value::Number(serde_json::Number::from(v)) }
    fn arr(v: &[&str]) -> Value { Value::Array(v.iter().map(|s| Value::String(s.to_string())).collect()) }

    #[test]
    fn test_from_params_minimal() {
        let m = mk(&[("username", s("deploy"))]);
        assert_eq!(m.username, "deploy");
        assert_eq!(m.state, "present");
    }

    #[test]
    fn test_from_params_name_alias() {
        let m = mk(&[("name", s("jdoe"))]);
        assert_eq!(m.username, "jdoe");
    }

    #[test]
    fn test_from_params_all() {
        let m = mk(&[
            ("username", s("jdoe")), ("uid", n(1001)), ("comment", s("John Doe")),
            ("shell", s("/bin/zsh")), ("home", s("/home/jdoe")),
            ("create_home", b(true)), ("system", b(true)), ("group", s("staff")),
            ("groups", arr(&["docker", "sudo"])), ("append", b(true)),
            ("password", s("$6$xyz")), ("update_password", s("on_create")),
            ("expires", n(1893456000)), ("password_lock", b(true)),
            ("generate_ssh_key", b(true)), ("ssh_key_type", s("ed25519")),
            ("ssh_key_bits", n(4096)),
            ("password_expire_max", n(90)), ("password_expire_min", n(1)),
            ("password_expire_warn", n(7)), ("non_unique", b(true)),
            ("force", b(true)), ("remove", b(true)),
        ]);
        assert_eq!(m.uid, Some(1001));
        assert_eq!(m.comment.as_deref(), Some("John Doe"));
        assert_eq!(m.shell.as_deref(), Some("/bin/zsh"));
        assert_eq!(m.password_expire_max, Some(90));
        assert!(m.generate_ssh_key);
        assert_eq!(m.ssh_key_type, "ed25519");
        assert!(m.non_unique);
    }

    #[test]
    fn test_from_params_ssh_keys() {
        let m = mk(&[("username", s("x")), ("ssh_keys", arr(&["key1", "key2"]))]);
        assert_eq!(m.ssh_keys, vec!["key1", "key2"]);
    }

    #[test]
    fn test_from_params_expires_negative() {
        let m = mk(&[("username", s("x")), ("expires", n(i64::MAX as u64))]);
        assert!(m.expires.is_some());
    }

    #[tokio::test]
    async fn test_check_present_exists() {
        let mb = MockBackend::new();
        mb.expect_exec("id", &["-u", "deploy"], CommandOutput { stdout: "1001\n".into(), stderr: String::new(), exit_code: 0 });
        mb.expect_exec("getent", &["passwd", "deploy"], CommandOutput { stdout: "deploy:x:1001:1001::/home/deploy:/bin/bash\n".into(), stderr: String::new(), exit_code: 0 });
        let backend: Arc<dyn SystemBackend> = Arc::new(mb);
        let m = mk(&[("username", s("deploy"))]);
        assert!(m.check_state(&*backend).await.unwrap());
    }

    #[tokio::test]
    async fn test_check_present_missing() {
        let mb = MockBackend::new();
        mb.expect_exec("id", &["-u", "deploy"], CommandOutput { stdout: String::new(), stderr: "id: deploy: no such user\n".into(), exit_code: 1 });
        let backend: Arc<dyn SystemBackend> = Arc::new(mb);
        let m = mk(&[("username", s("deploy"))]);
        assert!(!m.check_state(&*backend).await.unwrap());
    }

    #[tokio::test]
    async fn test_check_absent_missing() {
        let mb = MockBackend::new();
        mb.expect_exec("id", &["-u", "deploy"], CommandOutput { stdout: String::new(), stderr: String::new(), exit_code: 1 });
        let backend: Arc<dyn SystemBackend> = Arc::new(mb);
        let m = mk(&[("username", s("deploy")), ("state", s("absent"))]);
        assert!(m.check_state(&*backend).await.unwrap());
    }

    #[tokio::test]
    async fn test_check_shell_mismatch() {
        let mb = MockBackend::new();
        mb.expect_exec("id", &["-u", "deploy"], CommandOutput { stdout: "1001\n".into(), stderr: String::new(), exit_code: 0 });
        mb.expect_exec("getent", &["passwd", "deploy"], CommandOutput { stdout: "deploy:x:1001:1001::/home/deploy:/bin/bash\n".into(), stderr: String::new(), exit_code: 0 });
        let backend: Arc<dyn SystemBackend> = Arc::new(mb);
        let m = mk(&[("username", s("deploy")), ("shell", s("/bin/zsh"))]);
        assert!(!m.check_state(&*backend).await.unwrap());
    }

    #[tokio::test]
    async fn test_apply_create_user() {
        let mb = MockBackend::new();
        mb.expect_exec("id", &["-u", "jdoe"], CommandOutput { stdout: String::new(), stderr: String::new(), exit_code: 1 });
        mb.expect_exec("useradd", &["-m", "jdoe"], CommandOutput { stdout: String::new(), stderr: String::new(), exit_code: 0 });
        let backend: Arc<dyn SystemBackend> = Arc::new(mb);
        let m = mk(&[("username", s("jdoe")), ("create_home", b(true))]);
        let r = m.apply_changes(&*backend).await.unwrap();
        assert!(r.changed);
        assert!(r.output.as_deref().unwrap_or("").contains("created"));
    }

    #[tokio::test]
    async fn test_apply_remove_user() {
        let mb = MockBackend::new();
        mb.expect_exec("id", &["-u", "jdoe"], CommandOutput { stdout: "1001\n".into(), stderr: String::new(), exit_code: 0 });
        mb.expect_exec("userdel", &["-f", "jdoe"], CommandOutput { stdout: String::new(), stderr: String::new(), exit_code: 0 });
        let backend: Arc<dyn SystemBackend> = Arc::new(mb);
        let m = mk(&[("username", s("jdoe")), ("state", s("absent"))]);
        let r = m.apply_changes(&*backend).await.unwrap();
        assert!(r.changed);
    }

    #[tokio::test]
    async fn test_apply_remove_with_home() {
        let mb = MockBackend::new();
        mb.expect_exec("id", &["-u", "jdoe"], CommandOutput { stdout: "1001\n".into(), stderr: String::new(), exit_code: 0 });
        mb.expect_exec("userdel", &["-f", "-r", "jdoe"], CommandOutput { stdout: String::new(), stderr: String::new(), exit_code: 0 });
        let backend: Arc<dyn SystemBackend> = Arc::new(mb);
        let m = mk(&[("username", s("jdoe")), ("state", s("absent")), ("remove", b(true))]);
        let r = m.apply_changes(&*backend).await.unwrap();
        assert!(r.changed);
    }

    #[tokio::test]
    async fn test_apply_create_with_groups() {
        let mb = MockBackend::new();
        mb.expect_exec("id", &["-u", "dev"], CommandOutput { stdout: String::new(), stderr: String::new(), exit_code: 1 });
        mb.expect_exec("useradd", &["-G", "docker,sudo", "-m", "dev"], CommandOutput { stdout: String::new(), stderr: String::new(), exit_code: 0 });
        let backend: Arc<dyn SystemBackend> = Arc::new(mb);
        let m = mk(&[("username", s("dev")), ("groups", arr(&["docker", "sudo"]))]);
        assert!(m.apply_changes(&*backend).await.unwrap().changed);
    }

    #[tokio::test]
    async fn test_apply_idempotent() {
        let mb = MockBackend::new();
        mb.expect_exec("id", &["-u", "existing"], CommandOutput { stdout: "1001\n".into(), stderr: String::new(), exit_code: 0 });
        mb.expect_exec("getent", &["passwd", "existing"], CommandOutput { stdout: "existing:x:1001:1001::/home/existing:/bin/bash\n".into(), stderr: String::new(), exit_code: 0 });
        let backend: Arc<dyn SystemBackend> = Arc::new(mb);
        let m = mk(&[("username", s("existing"))]);
        assert!(m.check_state(&*backend).await.unwrap());
    }
}
