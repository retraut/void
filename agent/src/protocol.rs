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
    Heartbeat { timestamp: u64 },
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

impl LogStream {
    pub fn as_str(self) -> &'static str {
        match self {
            LogStream::Stdout => "stdout",
            LogStream::Stderr => "stderr",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DeployStatus {
    Success,
    Failed,
}

impl DeployStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            DeployStatus::Success => "success",
            DeployStatus::Failed => "failed",
        }
    }
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
    #[serde(rename = "deploy")]
    Deploy {
        deployment_id: String,
        repo_url: String,
        #[serde(rename = "ref")]
        ref_: String,
        #[serde(default)]
        env: std::collections::BTreeMap<String, String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        build_command: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        serve_command: Option<String>,
        port: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        public_url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tunnel_token: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tunnel_id: Option<String>,
        /// HMAC-SHA256 signature: "v1.<64-hex>"
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sig: Option<String>,
    },
    #[serde(rename = "shutdown")]
    Shutdown {},
    #[serde(rename = "error")]
    Error {
        code: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
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
            AgentOut::Heartbeat { timestamp } => assert_eq!(timestamp, 1747526400),
            _ => panic!("expected Heartbeat"),
        }
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
    fn worker_to_agent_deploy_with_sig() {
        let raw = r#"{
            "type":"deploy",
            "deployment_id":"dep_1",
            "repo_url":"https://github.com/owner/repo",
            "ref":"main",
            "env":{"NODE_ENV":"production"},
            "port":3000,
            "sig":"v1.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        }"#;
        let f: WorkerToAgent = serde_json::from_str(raw).expect("parse");
        match f {
            WorkerToAgent::Deploy {
                ref_,
                port,
                sig,
                env,
                ..
            } => {
                assert_eq!(ref_, "main");
                assert_eq!(port, 3000);
                assert!(sig.is_some());
                assert_eq!(env.get("NODE_ENV").map(String::as_str), Some("production"));
            }
            _ => panic!("expected Deploy"),
        }
    }

    #[test]
    fn worker_to_agent_ping() {
        let raw = r#"{"type":"ping"}"#;
        let f: WorkerToAgent = serde_json::from_str(raw).expect("parse");
        matches!(f, WorkerToAgent::Ping {});
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
