//! void-agent config loader
//!
//! Reads from /etc/void/config.toml or env vars (for local dev).

use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    /// Worker WebSocket URL, e.g. wss://void.retraut.workers.dev/cell/<server_id>
    pub api_base: String,

    /// This server's stable ID (ULID). Generated on first boot if missing.
    pub server_id: String,

    /// One-time setup token used during first registration. After first
    /// successful register(), this is no longer needed.
    pub setup_token: String,

    /// Path to persistent state (Ed25519 keypair). Defaults to /var/lib/void.
    pub state_dir: Option<String>,

    /// HMAC secret for verifying deploy frame signatures. If unset, signature
    /// verification is skipped (dev mode only — production must set this).
    pub agent_shared_secret: Option<String>,
}

impl Config {
    pub fn load() -> anyhow::Result<Self> {
        // Try /etc/void/config.toml first
        let etc_path = "/etc/void/config.toml";
        if Path::new(etc_path).exists() {
            let raw = std::fs::read_to_string(etc_path)?;
            let cfg: Config = toml::from_str(&raw)?;
            return Ok(cfg);
        }

        // Fall back to env vars
        let api_base = std::env::var("VOID_API_BASE")
            .unwrap_or_else(|_| "ws://127.0.0.1:8787".to_string());
        let server_id = std::env::var("VOID_SERVER_ID")
            .unwrap_or_else(|_| {
                ulid::Ulid::new().to_string()
            });
        let setup_token = std::env::var("VOID_SETUP_TOKEN")
            .unwrap_or_else(|_| "dev-setup-token".to_string());
        let agent_shared_secret = std::env::var("VOID_AGENT_SHARED_SECRET").ok();

        Ok(Config {
            api_base,
            server_id,
            setup_token,
            state_dir: None,
            agent_shared_secret,
        })
    }

    pub fn state_dir(&self) -> std::path::PathBuf {
        self.state_dir
            .as_ref()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                dirs::data_local_dir()
                    .unwrap_or_else(|| std::path::PathBuf::from("."))
                    .join("void")
            })
    }

    /// Base directory for per-deployment work dirs (clones, builds).
    pub fn work_dir(&self) -> std::path::PathBuf {
        self.state_dir().join("work")
    }
}
