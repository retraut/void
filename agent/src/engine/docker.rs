use async_trait::async_trait;
use anyhow::{Context, Result};
use bollard::container::{
    Config, CreateContainerOptions, InspectContainerOptions, ListContainersOptions,
    RemoveContainerOptions, StartContainerOptions, StopContainerOptions,
};
use bollard::image::CreateImageOptions;
use bollard::models::{HostConfig, PortBinding, RestartPolicy, RestartPolicyNameEnum};
use bollard::Docker;
use futures_util::stream::StreamExt;
use serde_json::Value;
use std::collections::HashMap;
use tracing::info;
use crate::engine::backend::SystemBackend;
use crate::engine::module::{TaskModule, TaskResult};

pub struct DockerModule {
    name: String,
    container_name: String,
    image: String,
    state: String,
    ports: Vec<String>,
    env: Vec<String>,
    restart: Option<String>,
    pull: bool,
}

fn parse_port(s: &str) -> Result<(String, u16, u16)> {
    let parts: Vec<&str> = s.split(':').collect();
    match parts.len() {
        1 => {
            let p: u16 = parts[0].parse().context("invalid port")?;
            Ok(("tcp".into(), p, p))
        }
        2 => {
            let h: u16 = parts[0].parse().context("invalid host port")?;
            let c: u16 = parts[1].parse().context("invalid container port")?;
            Ok(("tcp".into(), h, c))
        }
        3 => {
            let h: u16 = parts[1].parse().context("invalid host port")?;
            let c: u16 = parts[2].parse().context("invalid container port")?;
            Ok((parts[0].into(), h, c))
        }
        _ => Err(anyhow::anyhow!("invalid port mapping: {}", s)),
    }
}

#[async_trait]
impl TaskModule for DockerModule {
    fn module_name(&self) -> &'static str { "docker" }
    fn task_name(&self) -> &str { &self.name }

    fn from_params(name: String, params: &HashMap<String, Value>) -> Result<Self> {
        let container_name = params.get("container_name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("docker: missing 'container_name'"))?
            .to_string();
        let image = params.get("image")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("docker: missing 'image'"))?
            .to_string();
        let state = params.get("state").and_then(|v| v.as_str()).unwrap_or("running").to_string();
        let ports = match params.get("ports") {
            Some(Value::Array(arr)) => {
                arr.iter().filter_map(|v| v.as_str().map(String::from)).collect()
            }
            _ => vec![],
        };
        let env = match params.get("env") {
            Some(Value::Object(m)) => {
                m.iter().map(|(k, v)| format!("{}={}", k, v.as_str().unwrap_or(""))).collect()
            }
            _ => vec![],
        };
        let restart = params.get("restart").and_then(|v| v.as_str()).map(String::from);
        let pull = params.get("pull").and_then(|v| v.as_bool()).unwrap_or(true);
        Ok(DockerModule { name, container_name, image, state, ports, env, restart, pull })
    }

    async fn check_state(&self, _backend: &dyn SystemBackend) -> Result<bool> {
        let docker = Docker::connect_with_local_defaults()
            .context("connect to docker daemon")?;

        let mut filters: HashMap<String, Vec<String>> = HashMap::new();
        filters.insert("name".into(), vec![self.container_name.clone()]);

        let containers = docker.list_containers(Some(ListContainersOptions {
            all: true,
            filters,
            ..Default::default()
        })).await?;

        if self.state == "absent" {
            return Ok(containers.is_empty());
        }

        let c = match containers.first() {
            Some(c) => c,
            None => return Ok(false),
        };

        if c.state.as_deref() != Some("running") {
            return Ok(false);
        }

        if let Some(ref img) = c.image {
            if !img.contains(&self.image) {
                return Ok(false);
            }
        } else {
            return Ok(false);
        }

        Ok(true)
    }

    async fn apply_changes(&self, _backend: &dyn SystemBackend) -> Result<TaskResult> {
        let docker = Docker::connect_with_local_defaults()
            .context("connect to docker daemon")?;

        if self.state == "absent" {
            docker.stop_container(&self.container_name, None::<StopContainerOptions>).await.ok();
            docker.remove_container(&self.container_name, None::<RemoveContainerOptions>).await
                .context(format!("remove {}", self.container_name))?;
            return Ok(TaskResult {
                name: self.name.clone(),
                module: "docker",
                changed: true,
                output: Some(format!("removed container {}", self.container_name)),
                error: None,
            });
        }

        // Pull image
        if self.pull {
            info!(image = %self.image, "pulling image");
            let empty = String::new();
            let mut stream = docker.create_image(
                Some(CreateImageOptions {
                    from_image: &self.image,
                    from_src: &empty,
                    tag: &empty,
                    repo: &empty,
                    changes: vec![],
                    platform: &empty,
                }),
                None,
                None,
            );
            while let Some(Ok(_)) = stream.next().await {}
        }

        // Kill + remove existing container if running
        let exists = docker.inspect_container(&self.container_name, None::<InspectContainerOptions>).await.is_ok();
        if exists {
            docker.stop_container(&self.container_name, None::<StopContainerOptions>).await.ok();
            docker.remove_container(&self.container_name, None::<RemoveContainerOptions>).await
                .context(format!("remove existing {}", self.container_name))?;
        }

        // Build port mappings
        let mut exposed_ports: HashMap<String, HashMap<(), ()>> = HashMap::new();
        let mut port_bindings: HashMap<String, Option<Vec<PortBinding>>> = HashMap::new();
        for p in &self.ports {
            let (proto, host, container) = parse_port(p)?;
            let key = format!("{}/{}", container, proto);
            exposed_ports.entry(key.clone()).or_default();
            let binding = PortBinding {
                host_ip: Some("0.0.0.0".into()),
                host_port: Some(host.to_string()),
            };
            port_bindings.insert(key, Some(vec![binding]));
        }

        let host_config = HostConfig {
            port_bindings: Some(port_bindings),
            restart_policy: self.restart.as_ref().map(|r| RestartPolicy {
                name: Some(match r.as_str() {
                    "always" => RestartPolicyNameEnum::ALWAYS,
                    "unless-stopped" => RestartPolicyNameEnum::UNLESS_STOPPED,
                    "on-failure" => RestartPolicyNameEnum::ON_FAILURE,
                    _ => RestartPolicyNameEnum::NO,
                }),
                maximum_retry_count: None,
            }),
            ..Default::default()
        };

        let config = Config {
            image: Some(self.image.clone()),
            env: Some(self.env.clone()),
            exposed_ports: Some(exposed_ports),
            host_config: Some(host_config),
            ..Default::default()
        };

        docker.create_container(
            Some(CreateContainerOptions {
                name: &self.container_name,
                platform: None,
            }),
            config,
        ).await.context(format!("create container {}", self.container_name))?;

        docker.start_container(&self.container_name, None::<StartContainerOptions<String>>).await
            .context(format!("start container {}", self.container_name))?;

        Ok(TaskResult {
            name: self.name.clone(),
            module: "docker",
            changed: true,
            output: Some(format!("created and started {} from {}", self.container_name, self.image)),
            error: None,
        })
    }
}
