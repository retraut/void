//! void-agent main loop
//!
//! Lifecycle:
//! 1. Load config + identity
//! 2. Open WebSocket to Worker /cell/:server_id
//! 3. Send `register` (with public key + setup_token)
//! 4. Loop: send heartbeat every 5s, receive `deploy` commands, run them, stream logs
//! 5. Reconnect with exponential backoff on disconnect

mod config;
mod connection;
mod crypto;
mod deploy;
mod inventory;
mod keys;
mod log;
mod logging;
mod protocol;

use anyhow::{Context, Result};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::sleep;
use tracing::{error, info, warn};

use config::Config;
use keys::Identity;

#[tokio::main]
async fn main() -> Result<()> {
	let _ = rustls::crypto::ring::default_provider().install_default();

	logging::init();

	let cfg = Config::load().context("loading config")?;
	let state_dir = cfg.state_dir();
	let identity = Arc::new(Identity::load_or_create(&state_dir).context("loading identity")?);

	// Make sure the per-deployment log directory exists. Logs are
	// appended to JSONL files (one per deployment) so they survive a
	// WebSocket disconnect and can be tailed/inspected offline.
	// See log::emit_log() for the write path. We also stash the state
	// dir in VOID_STATE_DIR so the append_to_jsonl_log() helper
	// can find it without us having to plumb the PathBuf through
	// every function.
	let logs_dir = state_dir.join("logs");
	if let Err(e) = std::fs::create_dir_all(&logs_dir) {
		warn!(error = %e, dir = %logs_dir.display(), "could not create logs dir, per-deploy file logs will be skipped");
	}
	std::env::set_var("VOID_STATE_DIR", &state_dir);

	info!(
		server_id = %cfg.server_id,
		public_key = %identity.public_key_b64(),
		api_base = %cfg.api_base,
		state_dir = %state_dir.display(),
		"void-agent starting"
	);

    let mut backoff_ms = 1_000u64;
    loop {
        match connection::run_session(&cfg, &identity).await {
            Ok(_) => {
                info!("session ended cleanly, reconnecting");
                backoff_ms = 1_000;
            }
            Err(e) => {
                error!(error = %e, "session errored, backing off {}ms", backoff_ms);
                sleep(Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(60_000);
            }
        }
    }
}
