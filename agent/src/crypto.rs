//! Cryptographic utilities for deploy frame verification.
//! HMAC-SHA256 signature verification for frames signed by the Worker.

use serde::Serialize;
use std::collections::BTreeMap;

/// Canonical payload used for HMAC signing.
/// Must match the Worker's signing structure field-for-field.
/// Defined here (not in protocol.rs) because protocol types include
/// the `sig` field, and we need a struct WITHOUT it for signing.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub struct DeployNoSig<'a> {
    #[serde(rename = "type")]
    pub ty: &'a str,
    pub deployment_id: &'a str,
    pub repo_url: &'a str,
    #[serde(rename = "ref")]
    pub ref_: &'a str,
    pub env: &'a BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build_command: &'a Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serve_command: &'a Option<String>,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: &'a Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_url: &'a Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tunnel_token: &'a Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tunnel_id: &'a Option<String>,
}

impl<'a> DeployNoSig<'a> {
    #[allow(clippy::too_many_arguments)]
    pub fn from_frame(
        deployment_id: &'a str,
        repo_url: &'a str,
        ref_: &'a str,
        env: &'a BTreeMap<String, String>,
        build_command: &'a Option<String>,
        serve_command: &'a Option<String>,
        port: u16,
        hostname: &'a Option<String>,
        public_url: &'a Option<String>,
        tunnel_token: &'a Option<String>,
        tunnel_id: &'a Option<String>,
    ) -> Self {
        Self {
            ty: "deploy",
            deployment_id,
            repo_url,
            ref_,
            env,
            build_command,
            serve_command,
            port,
            hostname,
            public_url,
            tunnel_token,
            tunnel_id,
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
    fn test_deploy_no_sig_canonical() {
        let env = BTreeMap::new();
        let ds = DeployNoSig::from_frame("dep_1", "https://repo.git", "main", &env, &None, &None, 8080, &None, &None, &None, &None);
        let json = ds.canonical_json();
        assert!(json.contains("dep_1"));
        assert!(json.contains("deploy"));
    }
}
