# Documentation map

The repository documentation is split by purpose. A document should answer one
kind of question; it should not mix current behavior, future design, operations,
and historical rationale.

## Start here

| Question | Document | Authority |
|---|---|---|
| How is the system built today? | [ARCHITECTURE.md](ARCHITECTURE.md) | Current implementation architecture |
| What is the agent wire contract? | [PROTOCOL.md](PROTOCOL.md) | Normative protocol reference |
| What should a component do? | [`../spec/`](../spec/) | Acceptance requirements; status declared per document |
| What shaped the product direction? | [SPEC.md](SPEC.md) | Historical target-design archive, not current state |
| What security work is known? | [`../SECURITY.md`](../SECURITY.md) | Point-in-time audit and backlog |
| Why was Hono selected? | [`../HONO.md`](../HONO.md) | Architecture decision record |
| How is the local lab operated? | [`../scripts/test-lab/README.md`](../scripts/test-lab/README.md) | Developer runbook |

## Source-of-truth rules

When documents disagree, use this order:

1. Runtime schemas and tests in `worker/src/protocol.ts` and
   `agent/src/protocol.rs` define what the binaries accept.
2. `PROTOCOL.md` explains that contract for humans.
3. `ARCHITECTURE.md` describes current component boundaries and data flow.
4. Component specs define intended acceptance behavior.
5. `SPEC.md` preserves historical target design and may be stale or superseded.

Code still wins over prose for observed behavior. A mismatch between code and a
normative document is a defect; update both in the same change.

## Document lifecycle

Every architecture or specification document should state one of these statuses:

- **Current** — verified against the implementation.
- **Target** — approved direction that is not fully implemented.
- **Planned** — proposed behavior with no implementation commitment yet.
- **Historical** — retained as decision context; not operational guidance.

Avoid checklists that present planned features as complete. Link evidence
(source module or test) when marking a requirement implemented.
