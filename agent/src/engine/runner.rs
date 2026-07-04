use std::collections::HashSet;
use std::sync::Arc;
use async_trait::async_trait;
use futures_util::future::join_all;
use serde::Serialize;
use tracing::{info, warn};
use crate::engine::backend::{BecomeBackend, SystemBackend};
use crate::engine::module::{TaskModule, TaskResult};

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub enum RunMode {
    Check,
    Apply,
}

#[derive(Debug, Serialize)]
pub struct Summary {
    pub ok: u32,
    pub changed: u32,
    pub failed: u32,
}

#[derive(Debug, Serialize)]
pub struct PlaybookResult {
    pub playbook: String,
    pub mode: RunMode,
    pub summary: Summary,
    pub tasks: Vec<TaskResult>,
}

pub struct Task {
    pub module: Box<dyn TaskModule>,
    pub notify: Vec<String>,
    pub use_become: bool,
    pub become_user: String,
}

pub struct Handler {
    pub name: String,
    pub module: Box<dyn TaskModule>,
}

pub struct Playbook {
    pub name: String,
    pub tasks: Vec<Task>,
    pub handlers: Vec<Handler>,
}

pub struct Runner {
    backend: Arc<dyn SystemBackend>,
}

impl Runner {
    pub fn new(backend: Arc<dyn SystemBackend>) -> Self {
        Self { backend }
    }

    fn backend_for<'a>(&'a self, task: &Task) -> Arc<dyn SystemBackend> {
        if task.use_become {
            Arc::new(BecomeBackend::new(self.backend.clone(), &task.become_user))
        } else {
            self.backend.clone()
        }
    }

    pub async fn run(&self, playbook: &Playbook, mode: RunMode) -> PlaybookResult {
        let num_tasks = playbook.tasks.len();

        // Phase 1 — concurrent check_state via join_all.
        // Each async block captures (i, backend_arc, task_ref).
        let checks: Vec<_> = playbook.tasks.iter().enumerate().map(|(i, task)| {
            let backend = self.backend_for(task);
            async move { (i, task.module.check_state(&*backend).await) }
        }).collect();

        let mut results: Vec<Option<TaskResult>> = vec![None; num_tasks];
        let mut dirty: Vec<usize> = Vec::new();

        for (i, state) in join_all(checks).await {
            match state {
                Ok(true) => {
                    info!(task = %playbook.tasks[i].module.task_name(), "check: ok");
                }
                Ok(false) => {
                    info!(task = %playbook.tasks[i].module.task_name(), "check: needs update");
                    dirty.push(i);
                }
                Err(e) => {
                    warn!(task = %playbook.tasks[i].module.task_name(), error = %e, "check: failed");
                    results[i] = Some(TaskResult {
                        name: playbook.tasks[i].module.task_name().to_string(),
                        module: playbook.tasks[i].module.module_name(),
                        changed: false,
                        output: None,
                        error: Some(format!("check_state: {}", e)),
                    });
                }
            }
        }

        if mode == RunMode::Check {
            return Self::finish(playbook, results, &dirty, mode, vec![]);
        }

        // Phase 2 — sequential apply_changes for dirty tasks
        let mut notified: HashSet<String> = HashSet::new();

        for &i in &dirty {
            let task = &playbook.tasks[i];
            let backend = self.backend_for(task);
            match task.module.apply_changes(&*backend).await {
                Ok(r) => {
                    if r.changed {
                        for h in &task.notify {
                            notified.insert(h.clone());
                            info!(handler = %h, "notified by {}", task.module.task_name());
                        }
                    }
                    results[i] = Some(r);
                }
                Err(e) => {
                    warn!(task = %task.module.task_name(), error = %e, "apply: failed");
                    results[i] = Some(TaskResult {
                        name: task.module.task_name().to_string(),
                        module: task.module.module_name(),
                        changed: false,
                        output: None,
                        error: Some(format!("apply_changes: {}", e)),
                    });
                }
            }
        }

        // Phase 3 — run notified handlers (definition order, deduped)
        let mut handler_results = Vec::new();
        for handler in &playbook.handlers {
            if !notified.contains(&handler.name) {
                continue;
            }
            info!(handler = %handler.name, "running handler");
            // Handlers use root become by default (following Ansible convention)
            let handler_backend = Arc::new(BecomeBackend::new(self.backend.clone(), "root"))
                as Arc<dyn SystemBackend>;
            match handler.module.apply_changes(&*handler_backend).await {
                Ok(r) => handler_results.push(r),
                Err(e) => {
                    warn!(handler = %handler.name, error = %e, "handler failed");
                    handler_results.push(TaskResult {
                        name: handler.name.clone(),
                        module: handler.module.module_name(),
                        changed: false,
                        output: None,
                        error: Some(format!("handler: {}", e)),
                    });
                }
            }
            notified.remove(&handler.name);
        }

        Self::finish(playbook, results, &dirty, mode, handler_results)
    }

    fn finish(
        playbook: &Playbook,
        mut results: Vec<Option<TaskResult>>,
        dirty: &[usize],
        mode: RunMode,
        handler_results: Vec<TaskResult>,
    ) -> PlaybookResult {
        let dirty_set: HashSet<usize> = dirty.iter().copied().collect();

        for (i, task) in playbook.tasks.iter().enumerate() {
            if results[i].is_some() {
                continue;
            }
            let was_applied = dirty_set.contains(&i);
            results[i] = Some(TaskResult {
                name: task.module.task_name().to_string(),
                module: task.module.module_name(),
                changed: was_applied,
                output: Some(if was_applied { "applied" } else { "up-to-date" }.into()),
                error: None,
            });
        }

        let all: Vec<TaskResult> = results.into_iter()
            .flatten()
            .chain(handler_results)
            .collect();

        let failed = all.iter().filter(|r| r.error.is_some()).count() as u32;
        let changed = all.iter().filter(|r| r.changed && r.error.is_none()).count() as u32;
        let ok = all.iter().filter(|r| r.error.is_none() && !r.changed).count() as u32;

        PlaybookResult {
            playbook: playbook.name.clone(),
            mode,
            summary: Summary {
                ok,
                changed,
                failed,
            },
            tasks: all,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use anyhow::Result;
    use crate::engine::backend::MockBackend;
    use crate::engine::module::TaskModule;

    struct PassModule(String);
    struct FailModule(String);

    #[async_trait]
    impl TaskModule for PassModule {
        fn module_name(&self) -> &'static str { "pass" }
        fn task_name(&self) -> &str { &self.0 }
        fn from_params(_: String, _: &std::collections::HashMap<String, serde_json::Value>) -> Result<Self> { unimplemented!() }
        async fn check_state(&self, _: &dyn SystemBackend) -> Result<bool> { Ok(true) }
        async fn apply_changes(&self, _: &dyn SystemBackend) -> Result<TaskResult> {
            Ok(TaskResult { name: self.0.clone(), module: "pass", changed: false, output: None, error: None })
        }
    }

    #[async_trait]
    impl TaskModule for FailModule {
        fn module_name(&self) -> &'static str { "fail" }
        fn task_name(&self) -> &str { &self.0 }
        fn from_params(_: String, _: &std::collections::HashMap<String, serde_json::Value>) -> Result<Self> { unimplemented!() }
        async fn check_state(&self, _: &dyn SystemBackend) -> Result<bool> { Ok(false) }
        async fn apply_changes(&self, _: &dyn SystemBackend) -> Result<TaskResult> {
            Ok(TaskResult { name: self.0.clone(), module: "fail", changed: true, output: None, error: None })
        }
    }

    #[tokio::test]
    async fn test_empty_playbook() {
        let b: Arc<dyn SystemBackend> = Arc::new(MockBackend::new());
        let runner = Runner::new(b);
        let pb = Playbook { name: "empty".into(), tasks: vec![], handlers: vec![] };
        let r = runner.run(&pb, RunMode::Apply).await;
        assert_eq!(r.summary.ok, 0);
        assert_eq!(r.summary.failed, 0);
    }

    #[tokio::test]
    async fn test_all_ok() {
        let b: Arc<dyn SystemBackend> = Arc::new(MockBackend::new());
        let runner = Runner::new(b);
        let pb = Playbook {
            name: "test".into(),
            tasks: vec![Task { module: Box::new(PassModule("ok1".into())), notify: vec![], use_become: false, become_user: "root".into() }],
            handlers: vec![],
        };
        let r = runner.run(&pb, RunMode::Apply).await;
        assert_eq!(r.summary.ok, 1);
        assert_eq!(r.summary.changed, 0);
        assert_eq!(r.summary.failed, 0);
    }

    #[tokio::test]
    async fn test_dirty_task_apply() {
        let b: Arc<dyn SystemBackend> = Arc::new(MockBackend::new());
        let runner = Runner::new(b);
        let pb = Playbook {
            name: "test".into(),
            tasks: vec![Task { module: Box::new(FailModule("dirty".into())), notify: vec![], use_become: false, become_user: "root".into() }],
            handlers: vec![],
        };
        let r = runner.run(&pb, RunMode::Apply).await;
        assert_eq!(r.summary.changed, 1);
        assert_eq!(r.summary.ok, 0);
    }

    #[tokio::test]
    async fn test_check_mode() {
        let b: Arc<dyn SystemBackend> = Arc::new(MockBackend::new());
        let runner = Runner::new(b);
        let pb = Playbook {
            name: "test".into(),
            tasks: vec![Task { module: Box::new(FailModule("dirty".into())), notify: vec![], use_become: false, become_user: "root".into() }],
            handlers: vec![],
        };
        let r = runner.run(&pb, RunMode::Check).await;
        assert_eq!(r.summary.changed, 1); // dry-run shows what WOULD change
        assert_eq!(r.mode, RunMode::Check);
    }

    #[tokio::test]
    async fn test_handler_notify() {
        let b: Arc<dyn SystemBackend> = Arc::new(MockBackend::new());
        let runner = Runner::new(b);
        let pb = Playbook {
            name: "test".into(),
            tasks: vec![Task { module: Box::new(FailModule("main".into())), notify: vec!["handler1".into()], use_become: false, become_user: "root".into() }],
            handlers: vec![Handler { name: "handler1".into(), module: Box::new(PassModule("h1".into())) }],
        };
        let r = runner.run(&pb, RunMode::Apply).await;
        // "main" changed + ran → notified handler1. handler1 check_state pass → up-to-date
        // So we get: main changed, handler ok
        assert_eq!(r.tasks.len(), 2);
    }
}
