//! Logging initialization for void-agent.
//!
//! Format is selected via the `LOG_FORMAT` env var:
//!   text (default)  — human-readable, coloured when stderr is a TTY.
//!                     Best for local dev / `tail -f agent.log`.
//!   json            — newline-delimited JSON, one record per log
//!                     line on stderr. Best for log shippers
//!                     (Loki / Datadog / Vector / Fluent Bit).
//!   json-pretty     — indented JSON, one record per line. Best for
//!                     humans who want the structure of json but
//!                     don't want to read minified output.
//! The level is always RUST_LOG (env-filter compatible).

use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, fmt};

pub(crate) fn init() {
	let log_format = std::env::var("LOG_FORMAT").unwrap_or_else(|_| "text".to_string());
	let env_filter = EnvFilter::try_from_default_env()
		.unwrap_or_else(|_| EnvFilter::new("info"));

	let json_layer = fmt::layer()
		.json()
		.flatten_event(true)
		.with_current_span(false)
		.with_span_list(false)
		.with_target(true)
		.with_file(false)
		.with_line_number(false)
		.with_writer(std::io::stderr);

	match log_format.as_str() {
		"json" => {
			tracing_subscriber::registry().with(env_filter).with(json_layer).init();
		}
		"json-pretty" => {
			tracing_subscriber::registry()
				.with(env_filter)
				.with(json_layer.pretty())
				.init();
		}
		_ => {
			// "text" or anything else — human-readable, stderr.
			tracing_subscriber::registry()
				.with(env_filter)
				.with(fmt::layer().with_writer(std::io::stderr))
				.init();
		}
	}
}
