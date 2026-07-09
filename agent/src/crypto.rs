//! Cryptographic utilities for pipeline frame verification.
//! HMAC-SHA256 signature verification for frames signed by the Worker.

use serde::Serialize;

use crate::protocol::PipelineStep;

/// Canonical payload used for HMAC signing of a `pipeline` frame.
/// Must match the Worker's signing structure field-for-field.
/// Omits `sig` (which is on the frame) and serializes the deployment
/// id + ordered steps into a stable canonical JSON.
#[derive(Serialize)]
pub struct PipelineNoSig<'a> {
    #[serde(rename = "type")]
    pub ty: &'a str,
    pub deployment_id: &'a str,
    pub steps: &'a [PipelineStep],
}

impl<'a> PipelineNoSig<'a> {
    pub fn from_frame(deployment_id: &'a str, steps: &'a [PipelineStep]) -> Self {
        Self {
            ty: "pipeline",
            deployment_id,
            steps,
        }
    }

    pub fn canonical_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// Verify HMAC-SHA256 signature of a deploy message.
/// Constant-time compare. Signature format: "v1.<hex>"
pub fn verify_hmac_sha256(secret: &str, payload: &str, signature: &str) -> bool {
    use hmac::{Hmac, Mac};
    use hmac::digest::KeyInit;
    use sha2::Sha256;

    let expected_hex = match signature.strip_prefix("v1.") {
        Some(h) => h,
        None => return false,
    };

    type HmacSha256 = Hmac<Sha256>;
    let mut mac = match HmacSha256::new_from_slice(secret.as_bytes()) {
        Ok(m) => m,
        Err(_) => return false,
    };
    mac.update(payload.as_bytes());
    let expected = mac.finalize().into_bytes();
    let expected_hex_str = hex::encode(expected);

    if expected_hex_str.len() != expected_hex.len() {
        return false;
    }
    let diff: u32 = expected_hex_str
        .bytes()
        .zip(expected_hex.bytes())
        .map(|(a, b)| (a ^ b) as u32)
        .sum();
    diff == 0
}

pub fn now_ts() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmac::{KeyInit, Mac};

    #[test]
    fn test_verify_valid_signature() {
        let secret = "test-secret";
        let payload = r#"{"type":"deploy","deployment_id":"dep_1"}"#;
        // Pre-computed HMAC-SHA256 with secret="test-secret" and payload above
        // Generated externally to avoid circular dependency
        let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(payload.as_bytes());
        let sig = format!("v1.{}", hex::encode(mac.finalize().into_bytes()));
        assert!(verify_hmac_sha256(secret, payload, &sig));
    }

    #[test]
    fn test_verify_invalid_signature() {
        assert!(!verify_hmac_sha256("secret", "payload", "v1.0000"));
    }

    #[test]
    fn test_verify_wrong_prefix() {
        assert!(!verify_hmac_sha256("secret", "payload", "v2.0000"));
    }

    #[test]
    fn test_pipeline_no_sig_canonical() {
        // Steps with no cwd/env must serialize WITHOUT those fields, and
        // in cmd → (env) → timeout_s order — this MUST match the Worker's
        // `JSON.stringify({type,deployment_id,steps})` canonical used for
        // HMAC signing. The Worker builds env only when present.
        let steps = vec![
            crate::protocol::PipelineStep { cmd: "git clone https://github.com/owner/repo .".into(), cwd: None, env: Default::default(), timeout_s: 300 },
            crate::protocol::PipelineStep { cmd: "docker run -d -p 3000:3000 myapp".into(), cwd: None, env: Default::default(), timeout_s: 300 },
        ];
        let ps = PipelineNoSig::from_frame("dep_1", &steps);
        let json = ps.canonical_json();
        assert_eq!(
            json,
            r#"{"type":"pipeline","deployment_id":"dep_1","steps":[{"cmd":"git clone https://github.com/owner/repo .","timeout_s":300},{"cmd":"docker run -d -p 3000:3000 myapp","timeout_s":300}]}"#
        );
    }

    #[test]
    fn test_pipeline_no_sig_canonical_with_env() {
        let mut env = std::collections::BTreeMap::new();
        env.insert("TUNNEL_TOKEN".to_string(), "secret".to_string());
        let steps = vec![
            crate::protocol::PipelineStep { cmd: "cloudflared tunnel run".into(), cwd: None, env, timeout_s: 300 },
        ];
        let ps = PipelineNoSig::from_frame("dep_1", &steps);
        let json = ps.canonical_json();
        assert_eq!(
            json,
            r#"{"type":"pipeline","deployment_id":"dep_1","steps":[{"cmd":"cloudflared tunnel run","env":{"TUNNEL_TOKEN":"secret"},"timeout_s":300}]}"#
        );
    }
}
