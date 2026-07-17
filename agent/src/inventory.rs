//! Read-only server facts exposed to the control plane.
//!
//! This intentionally reports metadata only: SSH private keys, certificate
//! private keys, environment variables, and arbitrary file contents never
//! leave the server.

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::process::Command;
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};

pub fn collect() -> Value {
	let system = System::new_with_specifics(
		RefreshKind::nothing()
			.with_cpu(CpuRefreshKind::everything())
			.with_memory(MemoryRefreshKind::everything()),
	);
	let addresses = command_stdout("hostname", &["-I"])
		.unwrap_or_default()
		.split_whitespace()
		.map(str::to_string)
		.collect::<Vec<_>>();
	let primary_ipv4 = addresses
		.iter()
		.find(|address| address.parse::<std::net::Ipv4Addr>().is_ok() && !address.starts_with("127."))
		.cloned();

	json!({
		"hostname": command_stdout("hostname", &[]),
		"os": os_name(),
		"kernel": command_stdout("uname", &["-r"]),
		"architecture": command_stdout("uname", &["-m"]),
		"uptime_seconds": read_uptime_seconds(),
		"cpu_count": system.cpus().len(),
		"total_memory_mb": system.total_memory() / 1024 / 1024,
		"disk": disk_info(),
		"network": {
			"addresses": addresses,
			"primary_ipv4": primary_ipv4,
			"open_ports": open_ports(),
		},
		"firewall": firewall_info(),
		"ssh": ssh_info(),
		"certificates": certificates(),
	})
}

fn command_stdout(program: &str, args: &[&str]) -> Option<String> {
	let output = Command::new(program).args(args).output().ok()?;
	if !output.status.success() {
		return None;
	}
	let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
	(!value.is_empty()).then_some(value)
}

fn os_name() -> Option<String> {
	let raw = fs::read_to_string("/etc/os-release").ok()?;
	raw.lines()
		.find_map(|line| line.strip_prefix("PRETTY_NAME=").map(|value| value.trim_matches('"').to_string()))
}

fn read_uptime_seconds() -> Option<u64> {
	fs::read_to_string("/proc/uptime").ok()?.split_whitespace().next()?.parse::<f64>().ok().map(|v| v as u64)
}

fn disk_info() -> Value {
	let Some(raw) = command_stdout("df", &["-Pk", "/"]) else { return Value::Null };
	let fields = raw.lines().last().unwrap_or_default().split_whitespace().collect::<Vec<_>>();
	if fields.len() < 5 { return Value::Null; }
	let total_kb = fields[1].parse::<u64>().unwrap_or(0);
	let used_kb = fields[2].parse::<u64>().unwrap_or(0);
	let percent = fields[4].trim_end_matches('%').parse::<u64>().unwrap_or(0);
	json!({
		"total_gb": total_kb as f64 / 1024.0 / 1024.0,
		"used_gb": used_kb as f64 / 1024.0 / 1024.0,
		"used_percent": percent,
	})
}

fn open_ports() -> Vec<Value> {
	let Some(raw) = command_stdout("ss", &["-lntup"]) else { return Vec::new() };
	let mut ports = Vec::new();
	for line in raw.lines().skip(1) {
		let fields = line.split_whitespace().collect::<Vec<_>>();
		if fields.len() < 5 { continue; }
		let protocol = fields[0].to_lowercase();
		let (address, port) = split_endpoint(fields[4]);
		if port == 0 { continue; }
		let process = line.split("users:((").nth(1).and_then(|value| value.split(',').next()).map(str::to_string);
		ports.push(json!({ "protocol": protocol, "address": address, "port": port, "process": process }));
		if ports.len() >= 50 { break; }
	}
	ports
}

fn split_endpoint(endpoint: &str) -> (String, u16) {
	let Some((address, port)) = endpoint.rsplit_once(':') else { return (endpoint.to_string(), 0) };
	let address = address.trim_matches(&['[', ']'][..]).to_string();
	(address, port.parse().unwrap_or(0))
}

fn firewall_info() -> Value {
	if let Some(raw) = command_stdout("ufw", &["status"]) {
		return json!({ "backend": "ufw", "active": raw.lines().any(|line| line.trim() == "Status: active"), "summary": raw.lines().take(8).collect::<Vec<_>>() });
	}
	if let Some(raw) = command_stdout("nft", &["list", "ruleset"]) {
		return json!({ "backend": "nftables", "active": !raw.trim().is_empty(), "summary": raw.lines().take(8).collect::<Vec<_>>() });
	}
	if let Some(raw) = command_stdout("iptables", &["-S"]) {
		return json!({ "backend": "iptables", "active": !raw.trim().is_empty(), "summary": raw.lines().take(8).collect::<Vec<_>>() });
	}
	json!({ "backend": null, "active": false, "summary": [] })
}

fn ssh_info() -> Value {
	let config = command_stdout("sshd", &["-T"]).or_else(|| command_stdout("/usr/sbin/sshd", &["-T"])).unwrap_or_default();
	let port = config_value(&config, "port").and_then(|value| value.parse::<u16>().ok()).unwrap_or(22);
	let password_authentication = config_value(&config, "passwordauthentication").map(|value| value == "yes");
	let permit_root_login = config_value(&config, "permitrootlogin");
	let users = passwd_users();
	json!({
		"port": port,
		"password_authentication": password_authentication,
		"permit_root_login": permit_root_login,
		"users": users,
	})
}

fn config_value(config: &str, key: &str) -> Option<String> {
	config.lines().find_map(|line| {
		let mut fields = line.split_whitespace();
		(fields.next() == Some(key)).then(|| fields.next().unwrap_or_default().to_string())
	})
}

fn passwd_users() -> Vec<Value> {
	let Ok(raw) = fs::read_to_string("/etc/passwd") else { return Vec::new() };
	let mut users = Vec::new();
	for line in raw.lines() {
		let fields = line.split(':').collect::<Vec<_>>();
		if fields.len() < 7 { continue; }
		let uid = fields[2].parse::<u32>().unwrap_or(u32::MAX);
		let shell = fields[6];
		if uid != 0 && uid < 1000 || shell.ends_with("/nologin") || shell.ends_with("/false") { continue; }
		let keys = authorized_keys(fields[0], fields[5]);
		users.push(json!({ "username": fields[0], "uid": uid, "shell": shell, "keys": keys }));
		if users.len() >= 50 { break; }
	}
	users
}

fn authorized_keys(_username: &str, home: &str) -> Vec<Value> {
	let path = Path::new(home).join(".ssh/authorized_keys");
	let Ok(raw) = fs::read_to_string(path) else { return Vec::new() };
	raw.lines().filter_map(|line| {
		let fields = line.split_whitespace().collect::<Vec<_>>();
		if fields.len() < 2 || fields[0].starts_with('#') { return None; }
		Some(json!({
			"type": fields[0],
			"fingerprint": key_fingerprint(fields[1]),
			"comment": if fields.len() > 2 { fields[2..].join(" ") } else { String::new() },
		}))
	}).take(100).collect()
}

fn key_fingerprint(encoded_key: &str) -> String {
	let Ok(key) = STANDARD.decode(encoded_key) else { return "invalid".to_string() };
	let digest = Sha256::digest(key);
	format!("SHA256:{}", STANDARD_NO_PAD.encode(digest))
}

fn certificates() -> Vec<Value> {
	let Ok(entries) = fs::read_dir("/etc/letsencrypt/live") else { return Vec::new() };
	entries.filter_map(Result::ok).filter_map(|entry| {
		let path = entry.path().join("fullchain.pem");
		if !path.exists() { return None; }
		let output = command_stdout("openssl", &["x509", "-in", path.to_str()?, "-noout", "-issuer", "-enddate"])?;
		let issuer = output.lines().find_map(|line| line.strip_prefix("issuer=")).map(str::to_string);
		let expires_at = output.lines().find_map(|line| line.strip_prefix("notAfter=")).map(str::to_string);
		Some(json!({ "name": entry.file_name().to_string_lossy(), "issuer": issuer, "expires_at": expires_at }))
	}).take(50).collect()
}

#[cfg(test)]
mod tests {
	use super::key_fingerprint;

	#[test]
	fn ssh_fingerprint_is_prefixed_and_stable() {
		assert!(key_fingerprint("aGVsbG8=").starts_with("SHA256:"));
		assert_eq!(key_fingerprint("not-base64"), "invalid");
	}
}
