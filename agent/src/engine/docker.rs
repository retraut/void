use async_trait::async_trait;
use anyhow::{Context, Result};
use bollard::container::{
    Config, CreateContainerOptions, InspectContainerOptions, ListContainersOptions,
    RemoveContainerOptions, StartContainerOptions, StopContainerOptions,
};
use bollard::image::CreateImageOptions;
use bollard::models::{
    HostConfig, PortBinding, RestartPolicy, RestartPolicyNameEnum,
    HealthConfig, DeviceMapping, Mount, MountTypeEnum,
};
use bollard::Docker;
use futures_util::stream::StreamExt;
use serde_json::Value;
use std::collections::HashMap;
use crate::engine::backend::SystemBackend;
use crate::engine::module::{TaskModule, TaskResult};

pub struct DockerModule {
    name: String,
    container_name: String,
    image: String,
    state: String,
    ports: Vec<String>,
    env: HashMap<String, String>,
    volumes: Vec<String>,
    network_mode: Option<String>,
    command: Option<Vec<String>>,
    entrypoint: Option<Vec<String>>,
    working_dir: Option<String>,
    user: Option<String>,
    labels: HashMap<String, String>,
    dns: Vec<String>,
    dns_search: Vec<String>,
    extra_hosts: Vec<String>,
    cap_add: Vec<String>,
    cap_drop: Vec<String>,
    privileged: bool,
    restart_policy: Option<String>,
    restart_retries: Option<u64>,
    healthcheck_test: Option<Vec<String>>,
    healthcheck_interval: Option<u64>,
    healthcheck_timeout: Option<u64>,
    healthcheck_retries: Option<u64>,
    healthcheck_start_period: Option<u64>,
    memory: Option<i64>,
    memory_swap: Option<i64>,
    memory_reservation: Option<i64>,
    cpu_shares: Option<u64>,
    cpu_quota: Option<i64>,
    cpu_set: Option<String>,
    devices: Vec<String>,
    sysctls: HashMap<String, String>,
    tmpfs: Vec<String>,
    security_opt: Vec<String>,
    read_only: bool,
    init: bool,
    stop_signal: Option<String>,
    stop_timeout: Option<u64>,
    auto_remove: bool,
    pull: bool,
}

fn parse_port(s: &str) -> Result<(String, u16, u16)> {
    let parts: Vec<&str> = s.split(':').collect();
    match parts.len() {
        1 => { let p: u16 = parts[0].parse()?; Ok(("tcp".into(), p, p)) }
        2 => { let h: u16 = parts[0].parse()?; let c: u16 = parts[1].parse()?; Ok(("tcp".into(), h, c)) }
        3 => { let h: u16 = parts[1].parse()?; let c: u16 = parts[2].parse()?; Ok((parts[0].into(), h, c)) }
        _ => Err(anyhow::anyhow!("invalid port: {}", s)),
    }
}

fn val_str<'a>(p: &'a HashMap<String, Value>, k: &str) -> Option<&'a str> { p.get(k).and_then(|v| v.as_str()) }
fn val_u64(p: &HashMap<String, Value>, k: &str) -> Option<u64> { p.get(k).and_then(|v| v.as_u64()) }
fn val_i64(p: &HashMap<String, Value>, k: &str) -> Option<i64> { p.get(k).and_then(|v| v.as_i64()) }
fn val_bool(p: &HashMap<String, Value>, k: &str) -> Option<bool> { p.get(k).and_then(|v| v.as_bool()) }
fn str_list(p: &HashMap<String, Value>, k: &str) -> Vec<String> {
    match p.get(k) {
        Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
        Some(Value::String(s)) => s.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
        _ => vec![],
    }
}
fn str_map(p: &HashMap<String, Value>, k: &str) -> HashMap<String, String> {
    match p.get(k) {
        Some(Value::Object(m)) => m.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect(),
        _ => HashMap::new(),
    }
}

fn build_exposed_ports(ports: &[String]) -> HashMap<String, HashMap<(), ()>> {
    let mut m = HashMap::new();
    for p in ports {
        if let Ok((proto, _host, container)) = parse_port(p) {
            m.insert(format!("{}/{}", container, proto), HashMap::new());
        }
    }
    m
}

fn build_port_bindings(ports: &[String]) -> HashMap<String, Option<Vec<PortBinding>>> {
    let mut m = HashMap::new();
    for p in ports {
        if let Ok((proto, host, container)) = parse_port(p) {
            let key = format!("{}/{}", container, proto);
            m.insert(key, Some(vec![PortBinding {
                host_ip: Some("0.0.0.0".into()),
                host_port: Some(host.to_string()),
            }]));
        }
    }
    m
}

fn build_volumes(vols: &[String]) -> (Vec<String>, Vec<Mount>) {
    let mut binds = Vec::new();
    let mut mounts = Vec::new();
    for v in vols {
        let parts: Vec<&str> = v.split(':').collect();
        if parts.len() >= 2 {
            let host = parts[0];
            let container = parts[1];
            let ro = parts.get(2).copied().unwrap_or("rw") == "ro";
            binds.push(format!("{}:{}", host, container));
            mounts.push(Mount {
                source: Some(host.to_string()),
                target: Some(container.to_string()),
                typ: Some(MountTypeEnum::BIND),
                read_only: Some(ro),
                ..Default::default()
            });
        }
    }
    (binds, mounts)
}

#[async_trait]
impl TaskModule for DockerModule {
    fn module_name(&self) -> &'static str { "docker" }
    fn task_name(&self) -> &str { &self.name }

    fn from_params(name: String, params: &HashMap<String, Value>) -> Result<Self> {
        let container_name = val_str(params, "container_name").or_else(|| val_str(params, "name"))
            .ok_or_else(|| anyhow::anyhow!("docker: missing 'container_name'"))?.to_string();
        let image = val_str(params, "image").ok_or_else(|| anyhow::anyhow!("docker: missing 'image'"))?.to_string();
        let state = val_str(params, "state").unwrap_or("running").to_string();
        let ports = str_list(params, "ports");
        let env = str_map(params, "env");
        let volumes = str_list(params, "volumes");

        let network_mode = val_str(params, "network_mode").map(String::from);
        let command = params.get("command").and_then(|v| match v {
            Value::String(s) => Some(shlex_split(s)),
            Value::Array(a) => Some(a.iter().filter_map(|v| v.as_str().map(String::from)).collect()),
            _ => None,
        });
        let entrypoint = params.get("entrypoint").and_then(|v| match v {
            Value::String(s) => Some(shlex_split(s)),
            Value::Array(a) => Some(a.iter().filter_map(|v| v.as_str().map(String::from)).collect()),
            _ => None,
        });
        let working_dir = val_str(params, "working_dir").map(String::from);
        let user = val_str(params, "user").map(String::from);
        let labels = str_map(params, "labels");
        let dns = str_list(params, "dns");
        let dns_search = str_list(params, "dns_search");
        let extra_hosts = str_list(params, "extra_hosts");
        let cap_add = str_list(params, "cap_add");
        let cap_drop = str_list(params, "cap_drop");
        let privileged = val_bool(params, "privileged").unwrap_or(false);
        let restart_policy = val_str(params, "restart_policy").or_else(|| val_str(params, "restart")).map(String::from);
        let restart_retries = val_u64(params, "restart_retries");
        let healthcheck_test = params.get("healthcheck_test").and_then(|v| match v {
            Value::String(s) => Some(shlex_split(s)),
            Value::Array(a) => Some(a.iter().filter_map(|v| v.as_str().map(String::from)).collect()),
            _ => None,
        });
        let healthcheck_interval = val_u64(params, "healthcheck_interval");
        let healthcheck_timeout = val_u64(params, "healthcheck_timeout");
        let healthcheck_retries = val_u64(params, "healthcheck_retries");
        let healthcheck_start_period = val_u64(params, "healthcheck_start_period");
        let memory = val_i64(params, "memory");
        let memory_swap = val_i64(params, "memory_swap");
        let memory_reservation = val_i64(params, "memory_reservation");
        let cpu_shares = val_u64(params, "cpu_shares");
        let cpu_quota = val_i64(params, "cpu_quota");
        let cpu_set = val_str(params, "cpu_set").map(String::from);
        let devices = str_list(params, "devices");
        let sysctls = str_map(params, "sysctls");
        let tmpfs = str_list(params, "tmpfs");
        let security_opt = str_list(params, "security_opt");
        let read_only = val_bool(params, "read_only").unwrap_or(false);
        let init = val_bool(params, "init").unwrap_or(false);
        let stop_signal = val_str(params, "stop_signal").map(String::from);
        let stop_timeout = val_u64(params, "stop_timeout");
        let auto_remove = val_bool(params, "auto_remove").unwrap_or(false);
        let pull = val_bool(params, "pull").unwrap_or(true);

        Ok(DockerModule {
            name, container_name, image, state, ports, env, volumes, network_mode,
            command, entrypoint, working_dir, user, labels, dns, dns_search, extra_hosts,
            cap_add, cap_drop, privileged, restart_policy, restart_retries,
            healthcheck_test, healthcheck_interval, healthcheck_timeout, healthcheck_retries,
            healthcheck_start_period, memory, memory_swap, memory_reservation,
            cpu_shares, cpu_quota, cpu_set, devices, sysctls, tmpfs, security_opt,
            read_only, init, stop_signal, stop_timeout, auto_remove, pull,
        })
    }

    async fn check_state(&self, _backend: &dyn SystemBackend) -> Result<bool> {
        let docker = Docker::connect_with_local_defaults()
            .context("connect to docker daemon")?;

        let containers = self.list_containers(&docker).await?;
        if self.state == "absent" || self.state == "stopped" {
            let absent = containers.is_empty();
            if self.state == "absent" { return Ok(absent); }
            if self.state == "stopped" { return Ok(absent); } // stopped container still exists
        }

        let c = match containers.first() {
            Some(c) => c,
            None => return Ok(false),
        };

        let desired_running = matches!(self.state.as_str(), "running" | "started");
        let actual_running = c.state.as_deref() == Some("running");
        if desired_running && !actual_running { return Ok(false); }

        if let Some(ref img) = c.image {
            if !img.contains(&self.image) { return Ok(false); }
        } else { return Ok(false); }

        Ok(true)
    }

    async fn apply_changes(&self, _backend: &dyn SystemBackend) -> Result<TaskResult> {
        let docker = Docker::connect_with_local_defaults()
            .context("connect to docker daemon")?;

        // Pull image
        if self.pull && self.state != "absent" {
            let empty = String::new();
            let mut stream = docker.create_image(
                Some(CreateImageOptions {
                    from_image: &self.image, from_src: &empty,
                    tag: &empty, repo: &empty,
                    changes: vec![], platform: &empty,
                }), None, None,
            );
            while let Some(Ok(_)) = stream.next().await {}
        }

        // Handle absent / stopped
        let exists = docker.inspect_container(&self.container_name, None::<InspectContainerOptions>).await.is_ok();
        if self.state == "absent" {
            if exists {
                docker.stop_container(&self.container_name, None::<StopContainerOptions>).await.ok();
                docker.remove_container(&self.container_name, None::<RemoveContainerOptions>).await
                    .context(format!("remove {}", self.container_name))?;
            }
            return Ok(TaskResult { name: self.name.clone(), module: "docker", changed: exists,
                output: Some(if exists { format!("removed {}", self.container_name) } else { "already absent".into() }), error: None });
        }
        if self.state == "stopped" {
            if exists { docker.stop_container(&self.container_name, None::<StopContainerOptions>).await.ok(); }
            return Ok(TaskResult { name: self.name.clone(), module: "docker", changed: exists,
                output: Some(if exists { format!("stopped {}", self.container_name) } else { "already stopped".into() }), error: None });
        }

        // Remove existing for recreate
        if exists {
            docker.stop_container(&self.container_name, None::<StopContainerOptions>).await.ok();
            docker.remove_container(&self.container_name, None::<RemoveContainerOptions>).await
                .context(format!("remove existing {}", self.container_name))?;
        }

        // Build config
        let exposed_ports = build_exposed_ports(&self.ports);
        let port_bindings = build_port_bindings(&self.ports);
        let (binds, mounts) = build_volumes(&self.volumes);

        let healthcheck = self.healthcheck_test.as_ref().map(|test| {
            HealthConfig {
                test: Some(test.clone()),
                interval: self.healthcheck_interval.map(|n| n as i64 * 1_000_000_000),
                timeout: self.healthcheck_timeout.map(|n| n as i64 * 1_000_000_000),
                retries: self.healthcheck_retries.map(|n| n as i64),
                start_period: self.healthcheck_start_period.map(|n| n as i64 * 1_000_000_000),
                ..Default::default()
            }
        });

        let mut env_vec: Vec<String> = self.env.iter().map(|(k, v)| format!("{}={}", k, v)).collect();
        env_vec.sort();

        let host_config = HostConfig {
            port_bindings: Some(port_bindings),
            binds: if binds.is_empty() { None } else { Some(binds) },
            mounts: if mounts.is_empty() { None } else { Some(mounts) },
            network_mode: self.network_mode.clone(),
            privileged: Some(self.privileged),
            cap_add: if self.cap_add.is_empty() { None } else { Some(self.cap_add.clone()) },
            cap_drop: if self.cap_drop.is_empty() { None } else { Some(self.cap_drop.clone()) },
            dns: if self.dns.is_empty() { None } else { Some(self.dns.clone()) },
            dns_search: if self.dns_search.is_empty() { None } else { Some(self.dns_search.clone()) },
            extra_hosts: if self.extra_hosts.is_empty() { None } else { Some(self.extra_hosts.clone()) },
            memory: self.memory,
            memory_swap: self.memory_swap,
            memory_reservation: self.memory_reservation,
            cpu_shares: self.cpu_shares.map(|n| n as i64),
            cpu_quota: self.cpu_quota,
            cpuset_cpus: self.cpu_set.clone(),
            devices: if self.devices.is_empty() { None } else {
                Some(self.devices.iter().map(|d| DeviceMapping {
                    path_on_host: Some(d.clone()),
                    path_in_container: None,
                    cgroup_permissions: None,
                }).collect())
            },
            sysctls: if self.sysctls.is_empty() { None } else { Some(self.sysctls.clone()) },
            tmpfs: if self.tmpfs.is_empty() { None } else {
                Some(self.tmpfs.iter().map(|t| {
                    let parts: Vec<&str> = t.split(':').collect();
                    (parts[0].to_string(), parts.get(1).unwrap_or(&"").to_string())
                }).collect())
            },
            security_opt: if self.security_opt.is_empty() { None } else { Some(self.security_opt.clone()) },
            readonly_rootfs: Some(self.read_only),
            init: Some(self.init),
            auto_remove: Some(self.auto_remove),
            // log_config would use bollard::models::LogConfig but it's named Config in stubs
            restart_policy: self.restart_policy.as_ref().map(|r| RestartPolicy {
                name: Some(match r.as_str() {
                    "always" => RestartPolicyNameEnum::ALWAYS,
                    "unless-stopped" => RestartPolicyNameEnum::UNLESS_STOPPED,
                    "on-failure" => RestartPolicyNameEnum::ON_FAILURE,
                    "no" => RestartPolicyNameEnum::NO,
                    _ => RestartPolicyNameEnum::ALWAYS,
                }),
                maximum_retry_count: self.restart_retries.map(|n| n as i64),
            }),
            ulimits: None,
            ..Default::default()
        };

        let config = Config {
            image: Some(self.image.clone()),
            env: Some(env_vec),
            exposed_ports: Some(exposed_ports),
            host_config: Some(host_config),
            cmd: self.command.clone(),
            entrypoint: self.entrypoint.clone(),
            working_dir: self.working_dir.clone(),
            user: self.user.clone(),
            labels: if self.labels.is_empty() { None } else { Some(self.labels.clone()) },
            stop_signal: self.stop_signal.clone(),
            stop_timeout: self.stop_timeout.map(|n| n as i64),
            healthcheck,
            ..Default::default()
        };

        docker.create_container(
            Some(CreateContainerOptions { name: &self.container_name, platform: None }),
            config,
        ).await.context(format!("create container {}", self.container_name))?;

        if self.state == "running" || self.state == "started" {
            docker.start_container(&self.container_name, None::<StartContainerOptions<String>>).await
                .context(format!("start container {}", self.container_name))?;
        }

        Ok(TaskResult {
            name: self.name.clone(),
            module: "docker",
            changed: true,
            output: Some(format!("created and started {} from {}", self.container_name, self.image)),
            error: None,
        })
    }
}

impl DockerModule {
    async fn list_containers(&self, docker: &Docker) -> Result<Vec<bollard::models::ContainerSummary>> {
        let mut filters = HashMap::new();
        filters.insert("name".to_string(), vec![self.container_name.clone()]);
        Ok(docker.list_containers(Some(ListContainersOptions {
            all: true, filters, ..Default::default()
        })).await?)
    }
}

fn shlex_split(s: &str) -> Vec<String> {
    s.split_whitespace().map(String::from).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(params: &[(&str, Value)]) -> DockerModule {
        let mut m = HashMap::new();
        for (k, v) in params { m.insert(k.to_string(), v.clone()); }
        DockerModule::from_params("test".into(), &m).expect("from_params")
    }
    fn s(v: &str) -> Value { Value::String(v.into()) }
    fn b(v: bool) -> Value { Value::Bool(v) }
    fn n(v: u64) -> Value { Value::Number(serde_json::Number::from(v)) }
    fn arr(v: &[&str]) -> Value { Value::Array(v.iter().map(|s| Value::String(s.to_string())).collect()) }
    fn obj(pairs: &[(&str, &str)]) -> Value {
        Value::Object(pairs.iter().map(|(k, v)| (k.to_string(), Value::String(v.to_string()))).collect())
    }

    #[test]
    fn test_from_params_minimal() {
        let m = mk(&[("image", s("nginx")), ("name", s("web"))]);
        assert_eq!(m.container_name, "web");
        assert_eq!(m.image, "nginx");
        assert_eq!(m.state, "running");
    }

    #[test]
    fn test_from_params_container_name_alias() {
        let m = mk(&[("container_name", s("web")), ("image", s("nginx"))]);
        assert_eq!(m.container_name, "web");
    }

    #[test]
    fn test_from_params_all() {
        let m = mk(&[
            ("image", s("nginx:alpine")), ("name", s("web")),
            ("state", s("started")), ("ports", arr(&["80:80", "443:443"])),
            ("env", obj(&[("NGINX_HOST", "example.com")])),
            ("volumes", arr(&["/host:/container"])),
            ("network_mode", s("bridge")),
            ("command", s("nginx -g daemon off")),
            ("entrypoint", s("/docker-entrypoint.sh")),
            ("working_dir", s("/app")), ("user", s("nginx")),
            ("labels", obj(&[("app", "web")])),
            ("dns", arr(&["8.8.8.8"])),
            ("dns_search", arr(&["example.com"])),
            ("extra_hosts", arr(&["host:127.0.0.1"])),
            ("cap_add", arr(&["NET_ADMIN"])), ("cap_drop", arr(&["ALL"])),
            ("privileged", b(true)),
            ("restart_policy", s("always")), ("restart_retries", n(5)),
            ("memory", n(536870912)), ("memory_swap", n(1073741824)),
            ("cpu_shares", n(512)), ("cpu_quota", n(50000)), ("cpu_set", s("0-1")),
            ("devices", arr(&["/dev/fuse"])),
            ("sysctls", obj(&[("net.ipv4.ip_forward", "1")])),
            ("tmpfs", arr(&["/tmp:size=64M"])),
            ("security_opt", arr(&["no-new-privileges"])),
            ("read_only", b(true)), ("init", b(true)),
            ("stop_signal", s("SIGTERM")), ("stop_timeout", n(30)),
            ("auto_remove", b(true)),
            ("healthcheck_test", arr(&["CMD", "curl", "-f", "http://localhost"])),
            ("healthcheck_interval", n(30)), ("healthcheck_timeout", n(10)),
            ("healthcheck_retries", n(3)), ("healthcheck_start_period", n(5)),
            ("pull", b(false)),
        ]);
        assert_eq!(m.ports, vec!["80:80", "443:443"]);
        assert_eq!(m.env.get("NGINX_HOST").map(String::as_str), Some("example.com"));
        assert!(m.privileged);
        assert_eq!(m.restart_policy.as_deref(), Some("always"));
        assert_eq!(m.memory, Some(536870912));
        assert_eq!(m.cpu_shares, Some(512));
        assert!(m.read_only);
        assert!(m.healthcheck_test.is_some());
        assert!(!m.pull);
    }

    #[test]
    fn test_parse_port_default() {
        let r = parse_port("80").unwrap();
        assert_eq!(r, ("tcp".into(), 80, 80));
    }

    #[test]
    fn test_parse_port_full() {
        let r = parse_port("8080:80").unwrap();
        assert_eq!(r, ("tcp".into(), 8080, 80));
    }

    #[test]
    fn test_parse_port_udp() {
        let r = parse_port("udp:53:53").unwrap();
        assert_eq!(r, ("udp".into(), 53, 53));
    }

    #[test]
    fn test_build_exposed_ports() {
        let r = build_exposed_ports(&["80:80".into(), "443:443".into()]);
        assert!(r.contains_key("80/tcp"));
        assert!(r.contains_key("443/tcp"));
    }

    #[test]
    fn test_build_port_bindings() {
        let r = build_port_bindings(&["8080:80".into()]);
        let v = r.get("80/tcp").expect("key").as_ref().expect("some");
        assert_eq!(v[0].host_port.as_deref(), Some("8080"));
    }

    #[test]
    fn test_volume_parsing() {
        let (binds, mounts) = build_volumes(&["/host:/container:ro".into()]);
        assert_eq!(binds[0], "/host:/container");
    }

    #[test]
    fn test_shlex_split() {
        assert_eq!(shlex_split("nginx -g daemon-off"), vec!["nginx", "-g", "daemon-off"]);
    }

    #[test]
    fn test_build_exposed_ports_empty() {
        let r = build_exposed_ports(&[]);
        assert!(r.is_empty());
    }
}
