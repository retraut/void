---
name: protocol-sync
kind: responsibility
version: 0.1.0
---

# Protocol Sync

> Стежить за синхронізацією протоколу між Rust-агентом та TypeScript-воркером.

### Requires

- `AgentProtocolSchema` — `agent/src/protocol.rs`
- `WorkerProtocolSchema` — `worker/src/protocol.ts`
- `ProtocolDoc` — `docs/PROTOCOL.md`

### Maintains

`ProtocolSyncState` — актуальний стан синхронізації з `drift`, `last_checked`,
`protocol_hash` і `doc_outdated`.

### Execution

1. Зіставити frame types і поля Rust та TypeScript схем.
2. Перевірити документацію протоколу.
3. Зафіксувати drift, hash і стан документації.
