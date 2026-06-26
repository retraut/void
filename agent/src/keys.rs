//! Ed25519 keypair management.
//!
//! Generates a new keypair on first run, persists to disk, exposes
//! the verifying (public) key. The signing side is currently unused —
//! deploy-frame authentication uses HMAC-SHA256 with a shared secret
//! (see `verify_hmac_sha256` in main.rs) — but the Ed25519 identity
//! is kept for future use (signed WS frames, signed deploy
//! requests from the worker, etc.). The private key is stored with
//! 0o600 perms on Unix.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{SigningKey, VerifyingKey};
use rand::RngCore;
use std::path::Path;

pub struct Identity {
    /// Kept for future use (signed WS frames, signed deploy requests).
    /// The compiler would otherwise warn it's never read.
    #[allow(dead_code)]
    pub signing: SigningKey,
    pub verifying: VerifyingKey,
}

impl Identity {
    pub fn load_or_create(dir: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let key_path = dir.join("key.priv");

        let signing = if key_path.exists() {
            let raw = std::fs::read(&key_path)?;
            let bytes: [u8; 32] = raw
                .as_slice()
                .try_into()
                .map_err(|_| anyhow::anyhow!("invalid key file"))?;
            SigningKey::from_bytes(&bytes)
        } else {
            let mut csprng = rand::thread_rng();
            let mut bytes = [0u8; 32];
            csprng.fill_bytes(&mut bytes);
            let key = SigningKey::from_bytes(&bytes);
            std::fs::write(&key_path, key.to_bytes())?;
            // restrict perms on Unix
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = std::fs::metadata(&key_path)?.permissions();
                perms.set_mode(0o600);
                std::fs::set_permissions(&key_path, perms)?;
            }
            key
        };

        let verifying = signing.verifying_key();
        Ok(Self {
            signing,
            verifying,
        })
    }

    pub fn public_key_b64(&self) -> String {
        B64.encode(self.verifying.to_bytes())
    }
}
