//! void Agent ↔ Worker protocol — Rust types
//!
//! These types are the Rust mirror of the Zod schemas in
//! `worker/src/protocol.ts`. They MUST stay in sync.
//!
//! Both sides:
//! - Use `deny_unknown_fields` to reject unknown fields (matches Zod `.strict()`)
//! - Use `serde(tag = "type", rename_all = "snake_case")` for the discriminated union
//! - Parse canonical JSON, not `JSON.parse(raw)`, so an extra trailing comma or
//!   wrong type causes the parse to fail with a clear error.
//!
//! Adding a field to one side without updating the other will cause the
//! receiving side to reject the frame — this is the point.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Metrics {
    pub cpu_percent: f64,
    pub memory_mb: f64,
    pub memory_percent: f64,
    /// 1/5/15-min load average (read from /proc/loadavg on Linux).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load_avg: Option<[f64; 3]>,
    /// Number of logical CPU cores (from sysinfo). Used to normalize
    /// load average into a per-core pressure value on the client.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_count: Option<u32>,
    /// Server pressure tier derived from per-core load average:
    /// "light" | "medium" | "high" | "extra-high". Computed on the
    /// agent where core count is authoritative.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pressure_tier: Option<PressureTier>,
}

/// Pressure classification, kept in sync with the worker's Zod enum
/// and the SPA's LoadTier. (De)serialized as a lowercase string.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PressureTier {
    Light,
    Medium,
    High,
    ExtraHigh,
}

/// Frames sent by the agent to the worker.
///
/// Tagged enum (mirrors `z.discriminatedUnion("type", [...])` on the TS side).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentOut {
    #[serde(rename = "register")]
    Register {
        server_id: String,
        public_key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        setup_token: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_token: Option<String>,
    },
    #[serde(rename = "heartbeat")]
    Heartbeat {
        timestamp: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metrics: Option<Metrics>,
    },
    #[serde(rename = "log")]
    Log {
        deployment_id: String,
        /// "stdout" or "stderr"
        stream: LogStream,
        data: String,
        line: u32,
    },
    #[serde(rename = "deploy_done")]
    DeployDone {
        deployment_id: String,
        /// "success" or "failed"
        status: DeployStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        local_url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename = "ready")]
    Ready { timestamp: u64 },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DeployStatus {
    Success,
    Failed,
}

/// A single pipeline step: a shell command the agent executes.
///
/// The Worker (not the user) builds the full command — clone, build,
/// run, tunnel — and sends it here. The agent is a thin executor: it
/// runs each step in order, streams logs, and reports the final status.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PipelineStep {
    /// Shell command to run (via `sh -c`).
    pub cmd: String,
    /// Working directory. Defaults to the deployment work dir.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Extra environment variables.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: std::collections::BTreeMap<String, String>,
    /// Timeout in seconds before the command is killed.
    #[serde(default = "default_step_timeout_s")]
    pub timeout_s: u64,
}

fn default_step_timeout_s() -> u64 {
    300
}

/// Frames sent by the worker to the agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
#[allow(dead_code)]
pub enum WorkerToAgent {
    #[serde(rename = "registered")]
    Registered {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_token: Option<String>,
    },
    #[serde(rename = "ping")]
    Ping {},
    #[serde(rename = "shutdown")]
    Shutdown {},
    /// Run an ordered list of shell steps. The Worker builds each command
    /// (clone / build / run / tunnel) and the agent executes them in order,
    /// streaming logs, stopping at the first failure.
    #[serde(rename = "pipeline")]
    Pipeline {
        deployment_id: String,
        #[serde(default)]
        steps: Vec<PipelineStep>,
        /// HMAC-SHA256 signature: "v1.<64-hex>". Covers the canonical JSON of
        /// the deployment (deployment_id + steps). Verified by the agent when
        /// AGENT_SHARED_SECRET is set.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sig: Option<String>,
    },
    #[serde(rename = "error")]
    Error {
        code: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// Push a freshly-rotated session_token to an already-connected agent.
    /// Sent periodically (hourly) by the DO without disconnecting the WS.
    /// HMAC-signed with AGENT_SHARED_SECRET (same scheme as `pipeline`).
    /// Agent writes the new token to disk and uses it for future reconnects.
    #[serde(rename = "token_rotation")]
    TokenRotation {
        session_token: String,
        /// HMAC-SHA256 of the canonical JSON, signed with AGENT_SHARED_SECRET.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sig: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialize_register_setup_token() {
        let raw = r#"{
            "type": "register",
            "server_id": "srv_abc",
            "public_key": "MCowBQYDK2VwAyEA",
            "setup_token": "set_xyz"
        }"#;
        let f: AgentOut = serde_json::from_str(raw).expect("parse");
        match f {
            AgentOut::Register {
                server_id,
                setup_token,
                session_token,
                ..
            } => {
                assert_eq!(server_id, "srv_abc");
                assert_eq!(setup_token.as_deref(), Some("set_xyz"));
                assert!(session_token.is_none());
            }
            _ => panic!("expected Register"),
        }
    }

    #[test]
    fn deserialize_register_rejects_extra_field() {
        let raw = r#"{
            "type": "register",
            "server_id": "srv_abc",
            "public_key": "key",
            "setup_token": "set_xyz",
            "extra_field": "nope"
        }"#;
        let r: Result<AgentOut, _> = serde_json::from_str(raw);
        assert!(r.is_err(), "deny_unknown_fields should reject extra_field");
    }

    #[test]
    fn deserialize_heartbeat() {
        let raw = r#"{"type":"heartbeat","timestamp":1747526400}"#;
        let f: AgentOut = serde_json::from_str(raw).expect("parse");
        match f {
            AgentOut::Heartbeat { timestamp, metrics } => {
                assert_eq!(timestamp, 1747526400);
                assert!(metrics.is_none());
            }
            _ => panic!("expected Heartbeat"),
        }
    }

    #[test]
    fn deserialize_heartbeat_with_metrics() {
        let raw = r#"{"type":"heartbeat","timestamp":1747526400,"metrics":{"cpu_percent":42.5,"memory_mb":512.0,"memory_percent":25.0}}"#;
        let f: AgentOut = serde_json::from_str(raw).expect("parse");
        match f {
            AgentOut::Heartbeat { timestamp, metrics } => {
                assert_eq!(timestamp, 1747526400);
                let m = metrics.expect("should have metrics");
                assert_eq!(m.cpu_percent, 42.5);
                assert_eq!(m.memory_mb, 512.0);
                assert_eq!(m.memory_percent, 25.0);
            }
            _ => panic!("expected Heartbeat"),
        }
    }

    #[test]
    fn deserialize_heartbeat_rejects_extra_field_in_metrics() {
        let raw = r#"{"type":"heartbeat","timestamp":1,"metrics":{"cpu_percent":0.0,"memory_mb":0.0,"memory_percent":0.0,"extra":"bad"}}"#;
        let r: Result<AgentOut, _> = serde_json::from_str(raw);
        assert!(r.is_err(), "deny_unknown_fields on Metrics should reject extra field");
    }

    #[test]
    fn deserialize_log_rejects_bad_stream() {
        let raw = r#"{
            "type":"log",
            "deployment_id":"dep_1",
            "stream":"stdoutx",
            "data":"x",
            "line":1
        }"#;
        let r: Result<AgentOut, _> = serde_json::from_str(raw);
        assert!(r.is_err(), "should reject unknown stream value");
    }

    #[test]
    fn deserialize_deploy_done_success() {
        let raw = r#"{
            "type":"deploy_done",
            "deployment_id":"dep_1",
            "status":"success",
            "url":"https://app.example.com",
            "local_url":"http://127.0.0.1:3000"
        }"#;
        let f: AgentOut = serde_json::from_str(raw).expect("parse");
        match f {
            AgentOut::DeployDone { status, url, .. } => {
                assert_eq!(status, DeployStatus::Success);
                assert_eq!(url.as_deref(), Some("https://app.example.com"));
            }
            _ => panic!("expected DeployDone"),
        }
    }

    #[test]
    fn worker_to_agent_ping() {
        let raw = r#"{"type":"ping"}"#;
        let f: WorkerToAgent = serde_json::from_str(raw).expect("parse");
        matches!(f, WorkerToAgent::Ping {});
    }

    #[test]
    fn worker_to_agent_pipeline_with_sig() {
        let raw = r#"{
            "type":"pipeline",
            "deployment_id":"dep_1",
            "steps":[
                {"cmd":"git clone https://github.com/owner/repo ."},
                {"cmd":"docker run -d -p 3000:3000 myapp"},
                {"cmd":"cloudflared tunnel run", "env":{"TUNNEL_TOKEN":"x"}}
            ],
            "sig":"v1.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        }"#;
        let f: WorkerToAgent = serde_json::from_str(raw).expect("parse");
        match f {
            WorkerToAgent::Pipeline { deployment_id, steps, sig } => {
                assert_eq!(deployment_id, "dep_1");
                assert_eq!(steps.len(), 3);
                assert_eq!(steps[0].cmd, "git clone https://github.com/owner/repo .");
                assert!(sig.is_some());
            }
            _ => panic!("expected Pipeline"),
        }
    }

    #[test]
    fn worker_to_agent_rejects_extra_field() {
        let raw = r#"{"type":"ping","extra":"nope"}"#;
        let r: Result<WorkerToAgent, _> = serde_json::from_str(raw);
        assert!(r.is_err());
    }

    #[test]
    fn register_serializes_with_only_setup_token() {
        let f = AgentOut::Register {
            server_id: "srv_abc".into(),
            public_key: "key".into(),
            setup_token: Some("set_xyz".into()),
            session_token: None,
        };
        let s = serde_json::to_string(&f).expect("serialize");
        assert!(s.contains("\"setup_token\":\"set_xyz\""));
        assert!(!s.contains("session_token"), "should skip None session_token");
    }
}
