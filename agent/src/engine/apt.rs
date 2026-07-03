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
    update_cache: bool,
    cache_valid_time: u64,
    default_release: Option<String>,
    install_recommends: Option<bool>,
    force: bool,
    purge: bool,
    autoremove: bool,
    allow_unauthenticated: bool,
    allow_downgrade: bool,
    only_upgrade: bool,
    deb: Option<String>,
    upgrade: Option<String>,
    dpkg_options: String,
    lock_timeout: u64,
    clean: bool,
    autoclean: bool,
    allow_change_held_packages: bool,
    fail_on_autoremove: bool,
    policy_rc_d: Option<i32>,
}

const APT_UPDATE_STAMP: &str = "/var/lib/apt/periodic/update-success-stamp";
const DEFAULT_DPKG_OPTIONS: &str = "force-confdef,force-confold";
const CACHE_ZERO: &str = "\n0 upgraded, 0 newly installed, 0 to remove";

fn val_str<'a>(params: &'a HashMap<String, Value>, key: &str) -> Option<&'a str> {
    params.get(key).and_then(|v| v.as_str())
}

fn val_u64(params: &HashMap<String, Value>, key: &str) -> Option<u64> {
    params.get(key).and_then(|v| v.as_u64())
}

fn val_i64(params: &HashMap<String, Value>, key: &str) -> Option<i64> {
    params.get(key).and_then(|v| v.as_i64())
}

fn val_bool(params: &HashMap<String, Value>, key: &str) -> Option<bool> {
    params.get(key).and_then(|v| v.as_bool())
}

fn str_list(params: &HashMap<String, Value>, key: &str) -> Vec<String> {
    match params.get(key) {
        Some(Value::Array(arr)) => arr.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
        Some(Value::String(s)) => vec![s.clone()],
        _ => vec![],
    }
}

fn expand_dpkg_options(opts: &str) -> String {
    opts.split(',')
        .filter(|s| !s.is_empty())
        .map(|o| format!("-o \"Dpkg::Options::=--{}\"", o.trim()))
        .collect::<Vec<_>>()
        .join(" ")
}

#[async_trait]
impl TaskModule for AptModule {
    fn module_name(&self) -> &'static str { "apt" }
    fn task_name(&self) -> &str { &self.name }

    fn from_params(name: String, params: &HashMap<String, Value>) -> Result<Self> {
        let packages = {
            let p = str_list(params, "packages");
            if !p.is_empty() { p } else {
                let n = str_list(params, "name");
                if !n.is_empty() { n } else { str_list(params, "pkg") }
            }
        };
        let state = val_str(params, "state").unwrap_or("present").to_string();
        let update_cache = val_bool(params, "update_cache").or_else(|| val_bool(params, "update-cache")).unwrap_or(false);
        let cache_valid_time = val_u64(params, "cache_valid_time").unwrap_or(0);
        let default_release = val_str(params, "default_release").or_else(|| val_str(params, "default-release")).map(String::from);
        let install_recommends = val_bool(params, "install_recommends").or_else(|| val_bool(params, "install-recommends"));
        let force = val_bool(params, "force").unwrap_or(false);
        let purge = val_bool(params, "purge").unwrap_or(false);
        let autoremove = val_bool(params, "autoremove").unwrap_or(false);
        let allow_unauthenticated = val_bool(params, "allow_unauthenticated").unwrap_or(false);
        let allow_downgrade = val_bool(params, "allow_downgrade").unwrap_or(false);
        let only_upgrade = val_bool(params, "only_upgrade").unwrap_or(false);
        let deb = val_str(params, "deb").map(String::from).filter(|s| !s.is_empty());
        let upgrade = val_str(params, "upgrade").map(String::from).filter(|s| *s != "no");
        let dpkg_options = val_str(params, "dpkg_options").unwrap_or(DEFAULT_DPKG_OPTIONS).to_string();
        let lock_timeout = val_u64(params, "lock_timeout").unwrap_or(60);
        let clean = val_bool(params, "clean").unwrap_or(false);
        let autoclean = val_bool(params, "autoclean").unwrap_or(false);
        let allow_change_held_packages = val_bool(params, "allow_change_held_packages").unwrap_or(false);
        let fail_on_autoremove = val_bool(params, "fail_on_autoremove").unwrap_or(false);
        let policy_rc_d = val_i64(params, "policy_rc_d").map(|v| v as i32);

        Ok(AptModule {
            name, packages, state, update_cache, cache_valid_time,
            default_release, install_recommends, force, purge, autoremove,
            allow_unauthenticated, allow_downgrade, only_upgrade, deb,
            upgrade, dpkg_options, lock_timeout, clean, autoclean,
            allow_change_held_packages, fail_on_autoremove, policy_rc_d,
        })
    }

    async fn check_state(&self, backend: &dyn SystemBackend) -> Result<bool> {
        // Clean / autoclean / autoremove — one-shot, always report needs-change
        if self.clean || self.autoclean || (self.autoremove && self.packages.is_empty()) {
            return Ok(false);
        }

        // Upgrade mode — check if any upgrades available
        if let Some(ref mode) = self.upgrade {
            return self.check_upgrade_needed(backend, mode).await;
        }

        // Deb install — check if the exact version is installed
        if let Some(ref deb_path) = self.deb {
            return self.check_deb_installed(backend, deb_path).await;
        }

        // Package state checks
        if self.packages.is_empty() {
            return Ok(true); // update_cache only, no packages to check
        }

        let for_latest = self.state == "latest";
        let for_absent = self.state == "absent";

        for pkg in &self.packages {
            let out = backend.execute("dpkg-query", &["-W", "-f=${db:Status-Status}", pkg]).await
                .context(format!("dpkg-query for {}", pkg))?;
            let installed = out.stdout.trim() == "installed";

            if for_absent {
                if self.purge {
                    let has_files = backend.execute("dpkg-query", &["-W", "-f=${db:Status-Status}", pkg]).await
                        .map(|o| o.stdout.trim() != "not-installed")
                        .unwrap_or(false);
                    if has_files { return Ok(false); }
                }
                if installed { return Ok(false); }
                continue;
            }

            // present / latest
            if !installed {
                return Ok(false);
            }

            if for_latest {
                let apt_out = backend.execute_with_env("apt-get", &["--just-print", "upgrade", pkg],
                    &[("DEBIAN_FRONTEND", "noninteractive")]).await?;
                if !apt_out.stdout.contains("0 upgraded") {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }

    async fn apply_changes(&self, backend: &dyn SystemBackend) -> Result<TaskResult> {
        // Handle standalone ops
        if self.clean {
            return self.run_apt_clean(backend).await;
        }
        if self.autoclean {
            return self.run_apt_get(backend, "autoclean", &[], vec![]).await;
        }
        if self.autoremove && self.packages.is_empty() && self.upgrade.is_none() {
            return self.run_apt_get(backend, "autoremove", &[], vec![]).await;
        }

        // Update cache if requested
        if self.update_cache || self.cache_valid_time > 0 {
            if self.cache_needs_update(backend).await {
                info!("updating apt cache");
                let env = [("DEBIAN_FRONTEND", "noninteractive")];
                backend.execute_with_env("apt-get", &["update", "-qq"], &env).await
                    .context("apt-get update failed")?;
            }
        }

        // Policy-rc-d wrapper
        let _policy = PolicyGuard::new(backend, self.policy_rc_d).await;

        // Upgrade mode
        if let Some(ref mode) = self.upgrade {
            return self.run_upgrade(backend, mode).await;
        }

        // Deb install
        if let Some(ref deb_path) = self.deb {
            return self.install_deb(backend, deb_path).await;
        }

        // Package install / remove
        match self.state.as_str() {
            "absent" => self.run_remove(backend).await,
            "latest" => self.run_install(backend, true).await,
            "present" | _ => self.run_install(backend, false).await,
        }
    }
}

impl AptModule {
    fn build_base_flags(&self) -> Vec<String> {
        let mut flags = Vec::new();
        let dpkg = expand_dpkg_options(&self.dpkg_options);
        if !dpkg.is_empty() {
            // HACK: shell out dpkg options as separate args isn't clean,
            // but apt-get expects them as -o key=val. We just pass the
            // dpkg_options directly since we shell out via sh.
        }
        flags.push("-y".to_string());
        if self.force {
            flags.push("--force-yes".to_string());
        }
        if self.allow_unauthenticated {
            flags.push("--allow-unauthenticated".to_string());
        }
        if self.allow_downgrade {
            flags.push("--allow-downgrades".to_string());
        }
        if self.allow_change_held_packages {
            flags.push("--allow-change-held-packages".to_string());
        }
        if self.only_upgrade {
            flags.push("--only-upgrade".to_string());
        }
        if self.autoremove {
            flags.push("--auto-remove".to_string());
        }
        if self.fail_on_autoremove {
            flags.push("--no-remove".to_string());
        }
        if let Some(ref release) = self.default_release {
            flags.push("-t".to_string());
            flags.push(release.clone());
        }
        if let Some(ref irecs) = self.install_recommends {
            flags.push(format!("-o APT::Install-Recommends={}", if *irecs { "yes" } else { "no" }));
        }
        let lock_opt = format!("-o DPkg::Lock::Timeout={}", self.lock_timeout);
        flags.push(lock_opt);
        flags
    }

    fn env(&self) -> Vec<(&str, &str)> {
        vec![("DEBIAN_FRONTEND", "noninteractive")]
    }

    async fn cache_needs_update(&self, backend: &dyn SystemBackend) -> bool {
        if self.cache_valid_time == 0 {
            return self.update_cache;
        }
        let stamp = APT_UPDATE_STAMP;
        let info = backend.stat(stamp).await.ok();
        // Fallback: check via stat command
        let out = backend.execute("stat", &["-c", "%Y", stamp]).await.ok();
        if let Some(o) = out {
            if let Ok(mtime_secs) = o.stdout.trim().parse::<u64>() {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs();
                return now.saturating_sub(mtime_secs) > self.cache_valid_time;
            }
        }
        self.update_cache
    }

    async fn run_apt_get(&self, backend: &dyn SystemBackend, subcmd: &str, extra: &[&str], packages: Vec<String>) -> Result<TaskResult> {
        let mut args = vec![subcmd.to_string()];
        let flags = self.build_base_flags();
        args.extend(flags);
        args.extend(extra.iter().map(|s| s.to_string()));
        args.extend(packages);

        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let out = backend.execute_with_env("apt-get", &refs, &self.env()).await
            .context(format!("apt-get {} failed", subcmd))?;

        let success = out.success();
        let stdout = out.stdout;
        let stderr = out.stderr;
        let changed = !stdout.contains(CACHE_ZERO) || subcmd == "install";
        Ok(TaskResult {
            name: self.name.clone(),
            module: "apt",
            changed,
            output: Some(stdout),
            error: if !success { Some(stderr) } else { None },
        })
    }

    async fn run_install(&self, backend: &dyn SystemBackend, latest: bool) -> Result<TaskResult> {
        let mut args = vec!["install".to_string()];
        let mut flags = self.build_base_flags();
        if !self.install_recommends.unwrap_or(true) {
            flags.push("-o".to_string());
            flags.push("APT::Install-Recommends=no".to_string());
        }
        if latest {
            // No special flag, apt-get install pkg will install latest
        }
        // Add dpkg options via -o flags
        for opt in self.dpkg_options.split(',') {
            let o = opt.trim();
            if !o.is_empty() {
                flags.push("-o".to_string());
                flags.push(format!("Dpkg::Options::=--{}", o));
            }
        }
        args.extend(flags);
        args.extend(self.packages.clone());

        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let out = backend.execute_with_env("apt-get", &refs, &self.env()).await
            .context(format!("apt-get install {:?} failed", self.packages))?;

        let success = out.success();
        let stdout = out.stdout;
        let stderr = out.stderr;
        Ok(TaskResult {
            name: self.name.clone(),
            module: "apt",
            changed: true,
            output: Some(stdout),
            error: if !success { Some(stderr) } else { None },
        })
    }

    async fn run_remove(&self, backend: &dyn SystemBackend) -> Result<TaskResult> {
        let mut args = vec!["remove".to_string()];
        let mut flags = Vec::<String>::new();
        flags.push("-y".to_string());
        if self.purge {
            args[0] = "purge".to_string();
        }
        if self.autoremove {
            flags.push("--auto-remove".to_string());
        }
        if self.force {
            flags.push("--force-yes".to_string());
        }
        // dpkg options
        for opt in self.dpkg_options.split(',') {
            let o = opt.trim();
            if !o.is_empty() {
                flags.push("-o".to_string());
                flags.push(format!("Dpkg::Options::=--{}", o));
            }
        }
        args.extend(flags);
        args.extend(self.packages.clone());

        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let out = backend.execute_with_env("apt-get", &refs, &self.env()).await
            .context(format!("apt-get remove {:?} failed", self.packages))?;

        let success = out.success();
        let stdout = out.stdout;
        let stderr = out.stderr;
        Ok(TaskResult {
            name: self.name.clone(),
            module: "apt",
            changed: true,
            output: Some(stdout),
            error: if !success { Some(stderr) } else { None },
        })
    }

    async fn run_upgrade(&self, backend: &dyn SystemBackend, mode: &str) -> Result<TaskResult> {
        let (cmd, upgrade_arg) = match mode {
            "dist" => ("apt-get", "dist-upgrade"),
            "full" => ("apt-get", "dist-upgrade"),
            "safe" | "yes" | _ => ("apt-get", "upgrade --with-new-pkgs"),
        };
        let mut args = upgrade_arg.split_whitespace().map(String::from).collect::<Vec<_>>();
        args.push("-y".to_string());
        if self.force {
            args.push("--force-yes".to_string());
        }
        if self.autoremove {
            args.push("--auto-remove".to_string());
        }
        if self.allow_unauthenticated {
            args.push("--allow-unauthenticated".to_string());
        }
        if self.allow_downgrade {
            args.push("--allow-downgrades".to_string());
        }
        for opt in self.dpkg_options.split(',') {
            let o = opt.trim();
            if !o.is_empty() {
                args.push("-o".to_string());
                args.push(format!("Dpkg::Options::=--{}", o));
            }
        }

        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let out = backend.execute_with_env(cmd, &refs, &self.env()).await
            .context(format!("{} {} failed", cmd, upgrade_arg))?;

        let success = out.success();
        let stdout = out.stdout;
        let stderr = out.stderr;
        let changed = !stdout.contains(CACHE_ZERO);
        Ok(TaskResult {
            name: self.name.clone(),
            module: "apt",
            changed,
            output: Some(stdout),
            error: if !success { Some(stderr) } else { None },
        })
    }

    async fn install_deb(&self, backend: &dyn SystemBackend, deb_path: &str) -> Result<TaskResult> {
        // Resolve URL debs by downloading first
        let local_path = if deb_path.contains("://") {
            let out = backend.execute("curl", &["-sSL", "-o", "/tmp/_apt_deb.deb", deb_path]).await
                .context(format!("download deb {}", deb_path))?;
            if !out.success() {
                return Ok(TaskResult {
                    name: self.name.clone(),
                    module: "apt",
                    changed: false,
                    output: None,
                    error: Some(format!("download failed: {}", out.stderr)),
                });
            }
            "/tmp/_apt_deb.deb"
        } else {
            deb_path
        };

        let dpkg_opts: Vec<String> = self.dpkg_options.split(',')
            .filter(|s| !s.is_empty())
            .map(|o| format!("--{}", o.trim()))
            .collect();

        let mut args = vec!["-i".to_string()];
        args.extend(dpkg_opts);
        args.push(local_path.to_string());

        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let out = backend.execute_with_env("dpkg", &refs, &self.env()).await
            .context(format!("dpkg -i {}", local_path))?;

        let success = out.success();
        let stdout = out.stdout;
        let stderr = out.stderr;
        Ok(TaskResult {
            name: self.name.clone(),
            module: "apt",
            changed: true,
            output: Some(stdout),
            error: if !success { Some(stderr) } else { None },
        })
    }

    async fn run_apt_clean(&self, backend: &dyn SystemBackend) -> Result<TaskResult> {
        let out = backend.execute_with_env("apt-get", &["clean"], &self.env()).await
            .context("apt-get clean failed")?;
        let success = out.success();
        let stdout = out.stdout;
        let stderr = out.stderr;
        Ok(TaskResult {
            name: self.name.clone(),
            module: "apt",
            changed: true,
            output: Some(stdout),
            error: if !success { Some(stderr) } else { None },
        })
    }

    async fn check_upgrade_needed(&self, backend: &dyn SystemBackend, _mode: &str) -> Result<bool> {
        let out = backend.execute_with_env("apt-get", &["--just-print", "upgrade"],
            &[("DEBIAN_FRONTEND", "noninteractive")]).await?;
        Ok(out.stdout.contains(CACHE_ZERO) && !out.stdout.contains("Inst "))
    }

    async fn check_deb_installed(&self, backend: &dyn SystemBackend, _deb_path: &str) -> Result<bool> {
        // Best-effort: check the first package to see if it's at the right version
        // Full version comparison requires parsing the .deb control file
        if self.packages.is_empty() {
            // Just check if the package from deb is installed by trying to parse
            // the deb file — for now, always report needs-change for deb mode
            return Ok(false);
        }
        for pkg in &self.packages {
            let out = backend.execute("dpkg-query", &["-W", "-f=${db:Status-Status}", pkg]).await?;
            if out.stdout.trim() != "installed" {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

// Policy-rc-d guard: creates /usr/sbin/policy-rc.d before ops, restores after
struct PolicyGuard<'a> {
    backend: &'a dyn SystemBackend,
    code: Option<i32>,
    had_backup: bool,
}

impl<'a> PolicyGuard<'a> {
    async fn new(backend: &'a dyn SystemBackend, code: Option<i32>) -> Self {
        if code.is_none() {
            return Self { backend, code: None, had_backup: false };
        }
        let exists = backend.file_exists("/usr/sbin/policy-rc.d").await;
        let had_backup = exists;
        if !exists {
            let content = format!("#!/bin/sh\nexit {}\n", code.unwrap());
            let _ = backend.write_file("/usr/sbin/policy-rc.d", &content, Some("0755")).await;
        }
        Self { backend, code, had_backup }
    }
}

impl<'a> Drop for PolicyGuard<'a> {
    fn drop(&mut self) {
        if self.code.is_none() { return; }
        // Can't do async in Drop, best-effort sync removal
        let path = std::path::Path::new("/usr/sbin/policy-rc.d");
        if !self.had_backup {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use crate::engine::backend::CommandOutput;

    fn mock_backend() -> (Arc<crate::engine::backend::MockBackend>, Arc<dyn SystemBackend>) {
        let mb = crate::engine::backend::MockBackend::new();
        let arc_mb = Arc::new(mb);
        let backend: Arc<dyn SystemBackend> = arc_mb.clone();
        (arc_mb, backend)
    }

    fn make_module(params: &[(&str, Value)]) -> AptModule {
        let mut m = HashMap::new();
        for (k, v) in params {
            m.insert(k.to_string(), v.clone());
        }
        AptModule::from_params("test".into(), &m).expect("from_params")
    }

    fn pkg(name: &str) -> Value { Value::String(name.into()) }
    fn pkgs(names: &[&str]) -> Value {
        Value::Array(names.iter().map(|s| Value::String(s.to_string())).collect())
    }
    fn boolv(b: bool) -> Value { Value::Bool(b) }
    fn num(n: u64) -> Value { Value::Number(serde_json::Number::from(n)) }

    // ── from_params ────────────────────────────────────────

    #[test]
    fn test_from_params_minimal() {
        let m = make_module(&[("packages", pkgs(&["curl"]))]);
        assert_eq!(m.packages, vec!["curl"]);
        assert_eq!(m.state, "present");
        assert!(!m.update_cache);
    }

    #[test]
    fn test_from_params_full() {
        let m = make_module(&[
            ("packages", pkgs(&["nginx", "apache2"])),
            ("state", pkg("latest")),
            ("update_cache", boolv(true)),
            ("cache_valid_time", num(3600)),
            ("default_release", pkg("stable")),
            ("install_recommends", boolv(false)),
            ("force", boolv(true)),
            ("purge", boolv(true)),
            ("autoremove", boolv(true)),
            ("allow_unauthenticated", boolv(true)),
            ("allow_downgrade", boolv(true)),
            ("only_upgrade", boolv(true)),
            ("lock_timeout", num(120)),
        ]);
        assert_eq!(m.packages, vec!["nginx", "apache2"]);
        assert_eq!(m.state, "latest");
        assert!(m.update_cache);
        assert_eq!(m.cache_valid_time, 3600);
        assert_eq!(m.default_release.as_deref(), Some("stable"));
        assert_eq!(m.install_recommends, Some(false));
        assert!(m.force);
        assert!(m.purge);
        assert!(m.autoremove);
        assert!(m.allow_unauthenticated);
        assert!(m.allow_downgrade);
        assert!(m.only_upgrade);
        assert_eq!(m.lock_timeout, 120);
    }

    #[test]
    fn test_from_params_deb() {
        let m = make_module(&[
            ("deb", pkg("/tmp/pkg.deb")),
        ]);
        assert_eq!(m.deb, Some("/tmp/pkg.deb".into()));
    }

    #[test]
    fn test_from_params_upgrade() {
        let m = make_module(&[
            ("upgrade", pkg("dist")),
        ]);
        assert_eq!(m.upgrade, Some("dist".into()));
    }

    #[test]
    fn test_from_params_aliases() {
        let m = make_module(&[("name", pkgs(&["curl"]))]);
        assert_eq!(m.packages, vec!["curl"]);

        let m = make_module(&[("pkg", pkgs(&["git"]))]);
        assert_eq!(m.packages, vec!["git"]);
    }

    #[test]
    fn test_from_params_aliases_update() {
        let m = make_module(&[("packages", pkgs(&["x"])), ("update-cache", boolv(true))]);
        assert!(m.update_cache);
    }

    // ── check_state ────────────────────────────────────────

    #[tokio::test]
    async fn test_check_installed() {
        let mb = crate::engine::backend::MockBackend::new();
        mb.expect_exec("dpkg-query", &["-W", "-f=${db:Status-Status}", "nginx"], CommandOutput {
            stdout: "installed".into(), stderr: String::new(), exit_code: 0,
        });
        let backend: Arc<dyn SystemBackend> = Arc::new(mb);
        let m = make_module(&[("packages", pkgs(&["nginx"]))]);
        assert!(m.check_state(&*backend).await.unwrap());
    }

    #[tokio::test]
    async fn test_check_not_installed() {
        let mb = crate::engine::backend::MockBackend::new();
        mb.expect_exec("dpkg-query", &["-W", "-f=${db:Status-Status}", "nginx"], CommandOutput {
            stdout: "not-installed".into(), stderr: String::new(), exit_code: 0,
        });
        let backend: Arc<dyn SystemBackend> = Arc::new(mb);
        let m = make_module(&[("packages", pkgs(&["nginx"]))]);
        assert!(!m.check_state(&*backend).await.unwrap());
    }

    #[tokio::test]
    async fn test_check_absent_when_installed() {
        let mb = crate::engine::backend::MockBackend::new();
        mb.expect_exec("dpkg-query", &["-W", "-f=${db:Status-Status}", "nginx"], CommandOutput {
            stdout: "installed".into(), stderr: String::new(), exit_code: 0,
        });
        let backend: Arc<dyn SystemBackend> = Arc::new(mb);
        let m = make_module(&[("packages", pkgs(&["nginx"])), ("state", pkg("absent"))]);
        assert!(!m.check_state(&*backend).await.unwrap());
    }

    #[tokio::test]
    async fn test_check_absent_when_not_installed() {
        let mb = crate::engine::backend::MockBackend::new();
        mb.expect_exec("dpkg-query", &["-W", "-f=${db:Status-Status}", "nginx"], CommandOutput {
            stdout: "not-installed".into(), stderr: String::new(), exit_code: 0,
        });
        let backend: Arc<dyn SystemBackend> = Arc::new(mb);
        let m = make_module(&[("packages", pkgs(&["nginx"])), ("state", pkg("absent"))]);
        assert!(m.check_state(&*backend).await.unwrap());
    }

    #[tokio::test]
    async fn test_check_multiple_packages() {
        let mb = crate::engine::backend::MockBackend::new();
        mb.expect_exec("dpkg-query", &["-W", "-f=${db:Status-Status}", "nginx"], CommandOutput {
            stdout: "installed".into(), stderr: String::new(), exit_code: 0,
        });
        mb.expect_exec("dpkg-query", &["-W", "-f=${db:Status-Status}", "curl"], CommandOutput {
            stdout: "installed".into(), stderr: String::new(), exit_code: 0,
        });
        let backend: Arc<dyn SystemBackend> = Arc::new(mb);
        let m = make_module(&[("packages", pkgs(&["nginx", "curl"]))]);
        assert!(m.check_state(&*backend).await.unwrap());
    }

    #[tokio::test]
    async fn test_check_multiple_one_missing() {
        let mb = crate::engine::backend::MockBackend::new();
        mb.expect_exec("dpkg-query", &["-W", "-f=${db:Status-Status}", "nginx"], CommandOutput {
            stdout: "installed".into(), stderr: String::new(), exit_code: 0,
        });
        mb.expect_exec("dpkg-query", &["-W", "-f=${db:Status-Status}", "curl"], CommandOutput {
            stdout: "not-installed".into(), stderr: String::new(), exit_code: 0,
        });
        let backend: Arc<dyn SystemBackend> = Arc::new(mb);
        let m = make_module(&[("packages", pkgs(&["nginx", "curl"]))]);
        assert!(!m.check_state(&*backend).await.unwrap());
    }

    #[tokio::test]
    async fn test_check_clean_always_needs_update() {
        let mb = crate::engine::backend::MockBackend::new();
        let backend: Arc<dyn SystemBackend> = Arc::new(mb);
        let m = make_module(&[("packages", pkgs(&["x"])), ("clean", boolv(true))]);
        assert!(!m.check_state(&*backend).await.unwrap());
    }

    // ── apply_changes flags construction ───────────────────

    #[test]
    fn test_build_flags_default() {
        let m = make_module(&[("packages", pkgs(&["x"]))]);
        let flags = m.build_base_flags();
        assert!(flags.contains(&"-y".to_string()));
        assert!(flags.iter().any(|f| f.contains("DPkg::Lock::Timeout=60")));
    }

    #[test]
    fn test_build_flags_force() {
        let m = make_module(&[("packages", pkgs(&["x"])), ("force", boolv(true))]);
        let flags = m.build_base_flags();
        assert!(flags.contains(&"--force-yes".to_string()));
    }

    #[test]
    fn test_build_flags_allow_downgrade() {
        let m = make_module(&[("packages", pkgs(&["x"])), ("allow_downgrade", boolv(true))]);
        let flags = m.build_base_flags();
        assert!(flags.contains(&"--allow-downgrades".to_string()));
    }

    #[test]
    fn test_build_flags_default_release() {
        let m = make_module(&[("packages", pkgs(&["x"])), ("default_release", pkg("stable"))]);
        let flags = m.build_base_flags();
        assert!(flags.contains(&"-t".to_string()));
        assert!(flags.contains(&"stable".to_string()));
    }

    #[test]
    fn test_build_flags_autoremove() {
        let m = make_module(&[("packages", pkgs(&["x"])), ("autoremove", boolv(true))]);
        let flags = m.build_base_flags();
        assert!(flags.contains(&"--auto-remove".to_string()));
    }

    #[test]
    fn test_dpkg_options_expand() {
        let result = expand_dpkg_options("force-confdef,force-confold");
        assert!(result.contains("force-confdef"));
        assert!(result.contains("force-confold"));
    }

    #[test]
    fn test_dpkg_options_empty() {
        let result = expand_dpkg_options("");
        assert_eq!(result, "");
    }

    // ── upgrade mode ───────────────────────────────────────

    #[test]
    fn test_upgrade_dist() {
        let m = make_module(&[("upgrade", pkg("dist"))]);
        assert_eq!(m.upgrade, Some("dist".into()));
    }

    #[test]
    fn test_upgrade_no_is_none() {
        let m = make_module(&[("packages", pkgs(&["x"])), ("upgrade", pkg("no"))]);
        assert_eq!(m.upgrade, None);
    }

    // ── deb mode ───────────────────────────────────────────

    #[test]
    fn test_deb_param() {
        let m = make_module(&[("deb", pkg("https://example.com/pkg.deb"))]);
        assert_eq!(m.deb, Some("https://example.com/pkg.deb".into()));
    }

    // ── PolicyGuard ────────────────────────────────────────

    #[test]
    fn test_policy_guard_noop() {
        // code=None → guard is a no-op
        let mb = crate::engine::backend::MockBackend::new();
        let guard = PolicyGuard { backend: &mb, code: None, had_backup: false };
        drop(guard);
    }
}
