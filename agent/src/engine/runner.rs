use std::collections::HashSet;
use std::sync::Arc;
use futures_util::future::join_all;
use serde::Serialize;
use tracing::{info, warn};
use crate::engine::backend::SystemBackend;
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

    pub async fn run(&self, playbook: &Playbook, mode: RunMode) -> PlaybookResult {
        let num_tasks = playbook.tasks.len();

        // Phase 1 — concurrent check_state via join_all.
        // Each async block captures (i, task_ref, backend_ref).
        // join_all polls all inline — borrows are valid for the call duration.
        let checks: Vec<_> = playbook.tasks.iter().enumerate().map(|(i, task)| {
            let backend = &*self.backend;
            async move { (i, task.module.check_state(backend).await) }
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
            match task.module.apply_changes(&*self.backend).await {
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
            match handler.module.apply_changes(&*self.backend).await {
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
