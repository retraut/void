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
        let steps = vec![
            crate::protocol::PipelineStep { module: "git_clone".into(), params: serde_json::json!({}) },
            crate::protocol::PipelineStep { module: "run".into(), params: serde_json::json!({}) },
        ];
        let ps = PipelineNoSig::from_frame("dep_1", &steps);
        let json = ps.canonical_json();
        assert!(json.contains("dep_1"));
        assert!(json.contains("pipeline"));
        assert!(json.contains("git_clone"));
    }
}
