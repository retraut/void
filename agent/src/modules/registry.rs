//! Module registry — builds a `Box<dyn Module>` from a wire step spec.

use serde_json::Value;

use crate::modules::build::Build;
use crate::modules::compose::Compose;
use crate::modules::daemon::Daemon;
use crate::modules::git_clone::GitClone;
use crate::modules::run::Run;
use crate::modules::shell::Shell;
use crate::pipeline::Module;

/// Construct the module named by `spec.module`, deserializing its params.
/// Panics if the module name is unknown or params are malformed — the
/// worker validates names before sending, so this is a programming error.
pub(crate) fn build_module(module: &str, params: &Value) -> Box<dyn Module> {
    match module {
        "git_clone" => Box::new(GitClone::from_params(params)),
        "build" => Box::new(Build::from_params(params)),
        "run" => Box::new(Run::from_params(params)),
        "compose" => Box::new(Compose::from_params(params)),
        "daemon" => Box::new(Daemon::from_params(params)),
        "shell" => Box::new(Shell::from_params(params)),
        other => panic!("unknown module: {}", other),
    }
}
