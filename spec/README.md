# Component specifications

These documents describe acceptance behavior at component boundaries. They are
not a substitute for the current architecture in
[`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) or the wire contract in
[`../docs/PROTOCOL.md`](../docs/PROTOCOL.md).

| Specification | Status | Scope |
|---|---|---|
| [`agent/spec.md`](agent/spec.md) | Current | Agent connection, execution, metrics |
| [`control-plane/spec.md`](control-plane/spec.md) | Mixed | Implemented core plus explicitly target scenarios |
| [`deploy/spec.md`](deploy/spec.md) | Target | Desired deployment lifecycle beyond current dispatcher |
| [`test-lab/spec.md`](test-lab/spec.md) | Current | Local integration environment |
| [`ui/spec.md`](ui/spec.md) | Mixed | Current read views plus planned mutations |
| [`cli/spec.md`](cli/spec.md) | Planned | CLI does not exist yet |

## Requirement discipline

- Use **SHALL** only for accepted behavior.
- Mark every unimplemented scenario **Target** or **Planned**.
- Add the automated test or source module as evidence when a scenario becomes
  implemented.
- Keep protocol field definitions out of component specs; link to
  `docs/PROTOCOL.md`.
- Keep roadmap and market positioning out of acceptance specs.
