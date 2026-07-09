//! Composable pipeline modules. Each is a generic primitive; product
//! specifics (caddy, any container) live in the step params / compose YAML.

pub(crate) mod build;
pub(crate) mod compose;
pub(crate) mod daemon;
pub(crate) mod git_clone;
pub(crate) mod registry;
pub(crate) mod run;
pub(crate) mod shell;
