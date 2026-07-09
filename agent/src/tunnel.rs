//! cloudflared tunnel management (idempotent, orphan-safe).

use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::time::Duration;
use tracing::{info, warn};

/// Ensure cloudflared is running for the given tunnel token. Idempotent:
/// - kills any previously tracked cloudflared instance (prevents orphan leak)
/// - if cloudflared is installed, start it in the background
/// - if cloudflared is not installed, return an error so the caller can log
/// - saves the new PID to a file for the next deploy to kill
pub(crate) async fn ensure_cloudflared(
    tunnel_token: &str,
    _hostname: &str,
    pid_file: Option<&std::path::Path>,
) -> Result<(), String> {
    // 1. check if cloudflared is on PATH
    let which = Command::new("which")
        .arg("cloudflared")
        .output()
        .await
        .map_err(|e| format!("which failed: {}", e))?;
    if !which.status.success() {
        return Err("cloudflared not found in PATH".to_string());
    }

    // 2. Kill any previously tracked cloudflared (prevents orphan leak on every deploy)
    if let Some(pid_path) = pid_file {
        if let Ok(pid_str) = std::fs::read_to_string(pid_path) {
            if let Ok(pid) = pid_str.trim().parse::<i32>() {
                // SIGTERM the old cloudflared, then clean up the pid file
                #[cfg(unix)]
                unsafe {
                    libc::kill(pid, libc::SIGTERM);
                }
                let _ = std::fs::remove_file(pid_path);
                info!(old_pid = pid, "killed previous cloudflared instance");
                // give it a moment to release the tunnel
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }

    // 3. start cloudflared as a background process
    // SECURITY: pass the token via TUNNEL_TOKEN env var, NOT as a CLI arg,
    // so it doesn't appear in `ps aux` output.
    let mut child = Command::new("cloudflared")
        .arg("tunnel")
        .arg("--no-autoupdate")
        .arg("run")
        .env("TUNNEL_TOKEN", tunnel_token)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false)
        .spawn()
        .map_err(|e| format!("spawn cloudflared failed: {}", e))?;

    let new_pid = child.id();

    // Save the new PID for next-time cleanup
    if let (Some(pid_path), Some(pid)) = (pid_file, new_pid) {
        if let Some(parent) = pid_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(pid_path, pid.to_string());
    }

    // capture initial output (timeout so we don't block forever)
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    if let Some(out) = stdout {
        let mut reader = BufReader::new(out).lines();
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            while let Ok(Some(line)) = reader.next_line().await {
                info!(target: "cloudflared", "{}", line);
            }
        })
        .await;
    }
    if let Some(err) = stderr {
        let mut reader = BufReader::new(err).lines();
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            while let Ok(Some(line)) = reader.next_line().await {
                warn!(target: "cloudflared", "{}", line);
            }
        })
        .await;
    }

    // Detach: don't wait on the child.
    tokio::spawn(async move {
        let _ = child.wait().await;
        info!("cloudflared process exited");
    });

    Ok(())
}
