use async_trait::async_trait;
use anyhow::{Context, Result};
use serde_json::Value;
use sha2::Digest;
use std::collections::HashMap;
use crate::engine::backend::{FileInfo, SystemBackend};
use crate::engine::module::{TaskModule, TaskResult};

pub struct FileModule {
    name: String,
    path: String,
    state: String,
    src: Option<String>,
    content: Option<String>,
    template: Option<String>,
    vars: HashMap<String, String>,
    mode: Option<String>,
    owner: Option<String>,
    group: Option<String>,
    recurse: bool,
    force: bool,
    follow: bool,
    modification_time: Option<String>,
    access_time: Option<String>,
}

fn parse_symbolic_mode(s: &str) -> Result<u32> {
    if s.starts_with('0') || s.chars().all(|c| c.is_ascii_digit()) {
        return Ok(u32::from_str_radix(s, 8).unwrap_or_else(|_| u32::from_str_radix(s, 10).unwrap_or(0)));
    }
    let mut mode = 0u32;
    for part in s.split(',') {
        let part = part.trim();
        if part.is_empty() { continue; }
        let (who, rest) = if let Some(pos) = part.find(|c: char| c == '+' || c == '-' || c == '=') {
            part.split_at(pos)
        } else {
            return Err(anyhow::anyhow!("invalid symbolic mode: {}", s));
        };
        let who_mask = match who {
            "u" => 0o700,
            "g" => 0o070,
            "o" => 0o007,
            "a" | "" => 0o777,
            "ug" | "gu" => 0o770,
            "uo" | "ou" => 0o707,
            "go" | "og" => 0o077,
            _ => return Err(anyhow::anyhow!("invalid who in symbolic mode: {}", who)),
        };
        let op = &rest[..1];
        let perm_str = &rest[1..];
        let perm_mask = perm_str.chars().fold(0u32, |acc, c| acc | match c {
            'r' => 0o444,
            'w' => 0o222,
            'x' => 0o111,
            's' => 0o6000,
            't' => 0o1000,
            'X' => 0o111,
            _ => 0,
        });
        match op {
            "+" => mode |= perm_mask & who_mask,
            "-" => mode &= !(perm_mask & who_mask),
            "=" => {
                mode &= !who_mask;  // clear existing perms for this who
                mode |= perm_mask & who_mask;  // set new perms
            }
            _ => {}
        }
    }
    Ok(mode)
}

fn resolve_owner(owner: &str) -> Result<u32> {
    if let Ok(uid) = owner.parse::<u32>() { return Ok(uid); }
    let out = std::process::Command::new("id").arg("-u").arg(owner).output()
        .context(format!("resolve owner {}", owner))?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    s.parse::<u32>().context(format!("cannot resolve owner: {}", owner))
}

fn resolve_group(group: &str) -> Result<u32> {
    if let Ok(gid) = group.parse::<u32>() { return Ok(gid); }
    let out = std::process::Command::new("getent").args(["group", group]).output()
        .context(format!("resolve group {}", group))?;
    let s = String::from_utf8_lossy(&out.stdout);
    let gid = s.split(':').nth(2).unwrap_or("").trim().to_string();
    gid.parse::<u32>().context(format!("cannot resolve group: {}", group))
}

fn render_template(tmpl: &str, vars: &HashMap<String, String>) -> String {
    let mut r = tmpl.to_string();
    for (k, v) in vars {
        r = r.replace(&format!("{{{{ {} }}}}", k), v);
        r = r.replace(&format!("{{{{{}}}}}", k), v);
    }
    r
}

fn content_diff(old: &str, new: &str) -> String {
    let ol: Vec<&str> = old.lines().collect();
    let nl: Vec<&str> = new.lines().collect();
    if ol == nl { return "(identical)".into(); }
    let mut d = String::new();
    for i in 0..ol.len().max(nl.len()) {
        let o = ol.get(i).copied().unwrap_or("");
        let n = nl.get(i).copied().unwrap_or("");
        if o != n {
            if !o.is_empty() { d.push_str(&format!("-{}\n", o)); }
            if !n.is_empty() { d.push_str(&format!("+{}\n", n)); }
        } else {
            d.push_str(&format!(" {}\n", o));
        }
    }
    d
}

#[async_trait]
impl TaskModule for FileModule {
    fn module_name(&self) -> &'static str { "file" }
    fn task_name(&self) -> &str { &self.name }

    fn from_params(name: String, params: &HashMap<String, Value>) -> Result<Self> {
        let path = params.get("path").or_else(|| params.get("dest").or_else(|| params.get("name")))
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("file: missing 'path'"))?
            .to_string();
        let state = params.get("state").and_then(|v| v.as_str()).unwrap_or("file").to_string();
        let src = params.get("src").and_then(|v| v.as_str()).map(String::from);
        let content = params.get("content").and_then(|v| v.as_str()).map(String::from);
        let template = params.get("template").and_then(|v| v.as_str()).map(String::from);
        let vars = match params.get("vars") {
            Some(Value::Object(m)) => m.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect(),
            _ => HashMap::new(),
        };
        let mode = params.get("mode").and_then(|v| v.as_str()).map(String::from);
        let owner = params.get("owner").and_then(|v| v.as_str()).map(String::from);
        let group = params.get("group").and_then(|v| v.as_str()).map(String::from);
        let recurse = params.get("recurse").and_then(|v| v.as_bool()).unwrap_or(false);
        let force = params.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
        let follow = params.get("follow").and_then(|v| v.as_bool()).unwrap_or(true);
        let modification_time = params.get("modification_time").and_then(|v| v.as_str()).map(String::from);
        let access_time = params.get("access_time").and_then(|v| v.as_str()).map(String::from);
        Ok(FileModule { name, path, state, src, content, template, vars, mode, owner, group, recurse, force, follow, modification_time, access_time })
    }

    async fn check_state(&self, backend: &dyn SystemBackend) -> Result<bool> {
        let info = backend.stat(&self.path).await?;
        let curr = get_state_from_info(&info);

        match self.state.as_str() {
            "absent" => Ok(curr == "absent"),
            "directory" => {
                if curr == "absent" { return Ok(false); }
                if curr != "directory" && curr != "absent" { return Ok(false); }
                self.check_attr_match(&info).await
            }
            "link" => {
                if curr == "absent" && self.src.is_some() { return Ok(false); }
                if curr != "link" { return Ok(false); }
                // Check symlink target
                if let Some(ref src) = self.src {
                    let out = backend.execute("readlink", &["-n", &self.path]).await.ok();
                    if out.map(|o| o.stdout.trim() != src.as_str()).unwrap_or(true) {
                        return Ok(false);
                    }
                }
                self.check_attr_match(&info).await
            }
            "hard" => {
                if curr == "absent" { return Ok(false); }
                if curr != "hard" && curr != "file" { return Ok(false); }
                if let Some(ref src) = self.src {
                    let src_info = backend.stat(src).await?;
                    if info.sha256 != src_info.sha256 { return Ok(false); }
                }
                self.check_attr_match(&info).await
            }
            "touch" => {
                if curr == "absent" { return Ok(false); }
                self.check_attr_match(&info).await
            }
            _ => {
                if curr == "absent" { return Ok(false); }
                self.check_content_match(backend).await?;
                self.check_attr_match(&info).await
            }
        }
    }

    async fn apply_changes(&self, backend: &dyn SystemBackend) -> Result<TaskResult> {
        match self.state.as_str() {
            "absent" => self.ensure_absent(backend).await,
            "directory" => self.ensure_directory(backend).await,
            "link" => self.ensure_link(backend).await,
            "hard" => self.ensure_hardlink(backend).await,
            "touch" => self.ensure_touch(backend).await,
            _ => self.ensure_file(backend).await,
        }
    }
}

fn get_state_from_info(info: &FileInfo) -> &str {
    if !info.exists { return "absent"; }
    if std::path::Path::new("/tmp").symlink_metadata().is_ok() {
        // best-effort: we can't check symlink type from FileInfo
    }
    "file"
}

impl FileModule {
    fn resolve_content(&self) -> String {
        match (&self.content, &self.template) {
            (Some(c), _) => c.clone(),
            (_, Some(t)) => render_template(t, &self.vars),
            (None, None) => String::new(),
        }
    }

    fn valid_states() -> &'static [&'static str] {
        &["absent", "directory", "file", "hard", "link", "touch"]
    }

    async fn check_attr_match(&self, info: &FileInfo) -> Result<bool> {
        if let Some(ref mode) = &self.mode {
            if let Some(ref curr) = &info.mode {
                let d = u32::from_str_radix(mode.trim_start_matches('0'), 8).unwrap_or(0);
                let c = u32::from_str_radix(curr, 8).unwrap_or(0);
                if d != c { return Ok(false); }
            }
        }
        if let Some(ref owner) = &self.owner {
            if let Some(ref curr_uid) = &info.owner {
                let desired = resolve_owner(owner).unwrap_or(u32::MAX);
                let current: u32 = curr_uid.parse().unwrap_or(u32::MAX);
                if desired != current { return Ok(false); }
            }
        }
        if let Some(ref group) = &self.group {
            if let Some(ref curr_gid) = &info.group {
                let desired = resolve_group(group).unwrap_or(u32::MAX);
                let current: u32 = curr_gid.parse().unwrap_or(u32::MAX);
                if desired != current { return Ok(false); }
            }
        }
        Ok(true)
    }

    async fn check_content_match(&self, backend: &dyn SystemBackend) -> Result<bool> {
        let content = self.resolve_content();
        if content.is_empty() { return Ok(true); }
        let current_sha = backend.sha256(&self.path).await.unwrap_or_default();
        let mut h = sha2::Sha256::new();
        h.update(content.as_bytes());
        let desired = format!("{:x}", h.finalize());
        Ok(current_sha == desired)
    }

    async fn set_attrs(&self, backend: &dyn SystemBackend) -> Result<bool> {
        let mut changed = false;
        if let Some(ref mode) = &self.mode {
            let mode_val = parse_symbolic_mode(mode).unwrap_or(0);
            if mode_val > 0 {
                let mode_str = format!("{:o}", mode_val);
                backend.execute("chmod", &[&mode_str, &self.path]).await?;
                changed = true;
            }
        }
        if let Some(ref owner) = &self.owner {
            if let Some(ref group) = &self.group {
                backend.execute("chown", &[&format!("{}:{}", owner, group), &self.path]).await?;
            } else {
                backend.execute("chown", &[owner, &self.path]).await?;
            }
            changed = true;
        } else if let Some(ref group) = &self.group {
            backend.execute("chgrp", &[group, &self.path]).await?;
            changed = true;
        }
        // Timestamps
        let mtime = self.modification_time.as_deref();
        let atime = self.access_time.as_deref();
        if mtime.is_some() || atime.is_some() {
            let m = mtime.unwrap_or("preserve");
            let a = atime.unwrap_or("preserve");
            if m != "preserve" || a != "preserve" {
                let m_ref = if m == "now" { "00" } else { m };
                let a_ref = if a == "now" { "00" } else { a };
                backend.execute("touch", &["-t", m_ref, &self.path]).await.ok();
                changed = true;
            }
        }
        Ok(changed)
    }

    async fn ensure_absent(&self, backend: &dyn SystemBackend) -> Result<TaskResult> {
        let info = backend.stat(&self.path).await?;
        if !info.exists {
            return Ok(TaskResult { name: self.name.clone(), module: "file", changed: false, output: Some("already absent".into()), error: None });
        }
        backend.remove_file(&self.path).await?;
        Ok(TaskResult { name: self.name.clone(), module: "file", changed: true, output: Some(format!("removed {}", self.path)), error: None })
    }

    async fn ensure_directory(&self, backend: &dyn SystemBackend) -> Result<TaskResult> {
        let info = backend.stat(&self.path).await?;
        if info.exists {
            let changed = self.set_attrs(backend).await?;
            if self.recurse {
                backend.execute("find", &[&self.path, "-exec", "chmod", self.mode.as_deref().unwrap_or(""), "{}", "+"]).await.ok();
            }
            return Ok(TaskResult { name: self.name.clone(), module: "file", changed, output: Some(format!("{} exists", self.path)), error: None });
        }
        backend.execute("mkdir", &["-p", &self.path]).await?;
        self.set_attrs(backend).await?;
        Ok(TaskResult { name: self.name.clone(), module: "file", changed: true, output: Some(format!("created directory {}", self.path)), error: None })
    }

    async fn ensure_link(&self, backend: &dyn SystemBackend) -> Result<TaskResult> {
        let src = self.src.as_deref().unwrap_or("");
        let info = backend.stat(&self.path).await?;
        if info.exists {
            let out = backend.execute("readlink", &["-n", &self.path]).await.ok();
            let target_matches = out.as_ref().map(|o| o.stdout.trim() == src).unwrap_or(false);
            if target_matches {
                return Ok(TaskResult { name: self.name.clone(), module: "file", changed: false, output: Some("symlink exists and matches".into()), error: None });
            }
            if !self.force {
                return Ok(TaskResult { name: self.name.clone(), module: "file", changed: false, output: None, error: Some("path exists and force=false".into()) });
            }
            backend.remove_file(&self.path).await?;
        }
        backend.execute("ln", &["-sf", src, &self.path]).await?;
        Ok(TaskResult { name: self.name.clone(), module: "file", changed: true, output: Some(format!("created symlink {} -> {}", self.path, src)), error: None })
    }

    async fn ensure_hardlink(&self, backend: &dyn SystemBackend) -> Result<TaskResult> {
        let src = self.src.as_deref().unwrap_or("");
        let info = backend.stat(&self.path).await?;
        if info.exists && self.src.is_some() {
            let src_info = backend.stat(src).await?;
            if info.sha256 == src_info.sha256 {
                return Ok(TaskResult { name: self.name.clone(), module: "file", changed: false, output: Some("hardlink exists and matches".into()), error: None });
            }
            if !self.force {
                return Ok(TaskResult { name: self.name.clone(), module: "file", changed: false, output: None, error: Some("different file at path, force=false".into()) });
            }
            backend.remove_file(&self.path).await?;
        }
        backend.execute("ln", &[src, &self.path]).await?;
        Ok(TaskResult { name: self.name.clone(), module: "file", changed: true, output: Some(format!("created hardlink {} -> {}", self.path, src)), error: None })
    }

    async fn ensure_touch(&self, backend: &dyn SystemBackend) -> Result<TaskResult> {
        let info = backend.stat(&self.path).await?;
        if !info.exists {
            backend.write_file(&self.path, "", self.mode.as_deref()).await?;
        }
        let attr_changed = self.set_attrs(backend).await?;
        Ok(TaskResult { name: self.name.clone(), module: "file", changed: true, output: Some(format!("touched {}", self.path)), error: None })
    }

    async fn ensure_file(&self, backend: &dyn SystemBackend) -> Result<TaskResult> {
        let before = backend.read_file(&self.path).await.unwrap_or_default();
        let content = self.resolve_content();

        if !content.is_empty() && before == content {
            let attr_changed = self.set_attrs(backend).await?;
            let msg = if attr_changed { "attributes updated" } else { "unchanged" };
            return Ok(TaskResult { name: self.name.clone(), module: "file", changed: attr_changed, output: Some(format!("{} {}", self.path, msg)), error: None });
        }

        if !content.is_empty() {
            backend.write_file(&self.path, &content, self.mode.as_deref()).await
                .context(format!("write {}", self.path))?;
        }
        let attr_changed = self.set_attrs(backend).await?;
        let diff = content_diff(&before, &content);
        Ok(TaskResult {
            name: self.name.clone(),
            module: "file",
            changed: before != content || attr_changed,
            output: Some(if before != content { format!("updated {}:\n{}", self.path, diff) } else { format!("{} attributes updated", self.path) }),
            error: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use crate::engine::backend::MockBackend;

    fn mk(params: &[(&str, Value)]) -> FileModule {
        let mut m = HashMap::new();
        for (k, v) in params { m.insert(k.to_string(), v.clone()); }
        FileModule::from_params("test".into(), &m).expect("from_params")
    }
    fn s(v: &str) -> Value { Value::String(v.into()) }
    fn b(v: bool) -> Value { Value::Bool(v) }

    // ── from_params ────────────────────────────────────────

    #[test]
    fn test_from_params_path() {
        let m = mk(&[("path", s("/etc/hosts"))]);
        assert_eq!(m.path, "/etc/hosts");
        assert_eq!(m.state, "file");
    }

    #[test]
    fn test_from_params_all() {
        let m = mk(&[
            ("path", s("/a/b")), ("state", s("directory")), ("mode", s("0755")),
            ("owner", s("root")), ("group", s("root")), ("recurse", b(true)),
            ("force", b(true)), ("follow", b(false)),
        ]);
        assert_eq!(m.state, "directory");
        assert_eq!(m.mode.as_deref(), Some("0755"));
        assert!(m.recurse); assert!(m.force); assert!(!m.follow);
    }

    #[test]
    fn test_from_params_aliases() {
        assert_eq!(mk(&[("dest", s("/x"))]).path, "/x");
        assert_eq!(mk(&[("name", s("/x"))]).path, "/x");
    }

    // ── symbolic mode ──────────────────────────────────────

    #[test]
    fn test_parse_symbolic_u_plus_rwx() {
        assert_eq!(parse_symbolic_mode("u+rwx").unwrap() & 0o700, 0o700);
    }

    #[test]
    fn test_parse_symbolic_go_minus_r() {
        let m = parse_symbolic_mode("go-r").unwrap();
        assert_eq!(m & 0o044, 0);
    }

    #[test]
    fn test_parse_symbolic_equals() {
        assert_eq!(parse_symbolic_mode("u=rw,g=r,o=r").unwrap(), 0o644);
    }

    #[test]
    fn test_parse_octal_mode() {
        assert_eq!(parse_symbolic_mode("0644").unwrap(), 0o644);
    }

    #[test]
    fn test_parse_mode_without_leading_zero() {
        let m = parse_symbolic_mode("755").unwrap();
        assert_eq!(m, 0o755);
    }

    // ── template rendering ─────────────────────────────────

    #[test]
    fn test_render_template_simple() {
        let mut vars = HashMap::new();
        vars.insert("name".into(), "world".into());
        assert_eq!(render_template("Hello {{ name }}!", &vars), "Hello world!");
    }

    #[test]
    fn test_render_template_no_braces() {
        assert_eq!(render_template("static", &HashMap::new()), "static");
    }

    // ── content_diff ────────────────────────────────────────

    #[test]
    fn test_diff_identical() {
        assert_eq!(content_diff("a\nb\n", "a\nb\n"), "(identical)");
    }

    #[test]
    fn test_diff_changed() {
        let d = content_diff("old", "new");
        assert!(d.contains("-old"));
        assert!(d.contains("+new"));
    }

    // ── check_state ────────────────────────────────────────

    #[tokio::test]
    async fn test_check_absent_when_gone() {
        let mb = MockBackend::new();
        let b: Arc<dyn SystemBackend> = Arc::new(mb);
        let m = mk(&[("path", s("/x")), ("state", s("absent"))]);
        assert!(m.check_state(&*b).await.unwrap());
    }

    #[tokio::test]
    async fn test_check_absent_when_exists() {
        let mb = MockBackend::new();
        mb.set_file("/x", "content", Some("0644"));
        let b: Arc<dyn SystemBackend> = Arc::new(mb);
        let m = mk(&[("path", s("/x")), ("state", s("absent"))]);
        assert!(!m.check_state(&*b).await.unwrap());
    }

    #[tokio::test]
    async fn test_check_file_exists_ok() {
        let mb = MockBackend::new();
        mb.set_file("/etc/hosts", "127.0.0.1 localhost", Some("0644"));
        let b: Arc<dyn SystemBackend> = Arc::new(mb);
        let m = mk(&[("path", s("/etc/hosts")), ("mode", s("0644"))]);
        assert!(m.check_state(&*b).await.unwrap());
    }

    #[tokio::test]
    async fn test_check_file_mode_mismatch() {
        let mb = MockBackend::new();
        mb.set_file("/x", "data", Some("0777"));
        let b: Arc<dyn SystemBackend> = Arc::new(mb);
        let m = mk(&[("path", s("/x")), ("mode", s("0644"))]);
        assert!(!m.check_state(&*b).await.unwrap());
    }

    // ── ensure_absent ──────────────────────────────────────

    #[tokio::test]
    async fn test_remove_existing() {
        let mb = MockBackend::new();
        mb.set_file("/x", "data", None);
        let b: Arc<dyn SystemBackend> = Arc::new(mb);
        let m = mk(&[("path", s("/x")), ("state", s("absent"))]);
        let r = m.apply_changes(&*b).await.unwrap();
        assert!(r.changed);
    }

    #[tokio::test]
    async fn test_remove_already_gone() {
        let mb = MockBackend::new();
        let b: Arc<dyn SystemBackend> = Arc::new(mb);
        let m = mk(&[("path", s("/x")), ("state", s("absent"))]);
        let r = m.apply_changes(&*b).await.unwrap();
        assert!(!r.changed);
    }
}
