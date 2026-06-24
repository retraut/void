//! Ed25519 keypair management.
//!
//! Generates a new keypair on first run, persists to disk, signs WS frames.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use rand::RngCore;
use std::path::Path;

pub struct Identity {
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

    pub fn sign(&self, msg: &[u8]) -> String {
        let sig = self.signing.sign(msg);
        B64.encode(sig.to_bytes())
    }
}
