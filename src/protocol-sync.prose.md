---
name: protocol-sync
kind: responsibility
version: 0.1.0
---

# Protocol Sync

> Стежить за синхронізацією протоколу між Rust-агентом (`agent/src/protocol.rs`)
> та TypeScript-воркером (`worker/src/protocol.ts`). Обидві сторони використовують
> `deny_unknown_fields` / `.strict()` — якщо поле є в одній схемі, але не в іншій,
> з'єднання падає. Ця відповідальність виявляє дрифт до того, як він ламає WS.

### Requires

- `AgentProtocolSchema` — Rust enum `AgentOut` + `WorkerToAgent` з
  `agent/src/protocol.rs` (serde `#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]`).
- `WorkerProtocolSchema` — TypeScript Zod-схеми `AgentOutFrameSchema` +
  `WorkerToAgentFrameSchema` з `worker/src/protocol.ts` (`z.discriminatedUnion("type", ...).strict()`).
- `ProtocolDoc` — `docs/PROTOCOL.md` з описом кожного фрейму.

### Maintains

`ProtocolSyncState` — актуальний стан синхронізації.

- `drift` — список розбіжностей:
  - `field_in_worker_not_in_agent` — поле є в TS-схемі, але відсутнє в Rust.
  - `field_in_agent_not_in_worker` — поле є в Rust, але відсутнє в TS-схемі.
  - `shape_mismatch` — поле є в обох, але типи різні (напр. `string` vs `enum`).
- `last_checked` — timestamp останньої перевірки.
- `protocol_hash` — SHA256 від канонічного JSON об'єднаних схем.
- `doc_outdated` — чи `docs/PROTOCOL.md` відображає актуальний стан фреймів.

#### drift_log

Фацет: лише список дрифтів. Змінюється тільки коли з'являється/зникає розбіжність.

#### freshness

Фацет: `last_checked` + `protocol_hash`. Змінюється при кожній перевірці (навіть
якщо дрифту немає) — дає downstream підписникам знати, що перевірка відбулась.

### Emits

- `protocol-drift-alert` — коли з'являється новий дрифт.
- `protocol-clean-bill` — коли дрифт зникає (фікс після попереднього alertу).
- `protocol-doc-stale` — коли `docs/PROTOCOL.md` не синхронізовано з кодом.

### Execution

1. Прочитати `worker/src/protocol.ts`: екстрагувати всі `z.object(...).strict()` —
   назви фреймів (`register`, `heartbeat`, `log`, `deploy_done`, `ready`,
   `pipeline`, `shutdown`, `token_rotation`) та поля кожного фрейму.
2. Прочитати `agent/src/protocol.rs`: екстрагувати всі варіанти `AgentOut` та
   `WorkerToAgent` — назви (`Register`, `Heartbeat`, `Log`, etc.) та поля через
   атрибути `#[serde(rename = "...")]`.
3. Зіставити назви фреймів: кожен `type` у TS повинен мати відповідник у Rust (case-insensitive, snake_case), включно з `inventory`.
4. Зіставити поля кожного фрейму: кожне поле в Zod `.strict()` об'єкті повинно
   мати відповідне поле в serde-структурі з `deny_unknown_fields`.
5. Зіставити типи: enum (`LogStream`, `DeployStatus`, `PressureTier`) повинні
   мати однакові варіанти з однаковими `#[serde(rename_all = "...")]`.
6. Перевірити `docs/PROTOCOL.md`: чи всі фрейми та поля задокументовані.
7. Якщо дрифт знайдено — записати в `drift`, емітнути `protocol-drift-alert`.
8. Якщо дрифту немає, але попередній стан мав дрифт — емітнути `protocol-clean-bill`.
9. Оновити `last_checked`, `protocol_hash`, `doc_outdated`.

### Continuity

input-driven — запускається при зміні будь-якого з трьох вхідних файлів (`protocol.ts`,
`protocol.rs`, `PROTOCOL.md`), або вручну через `prose run src/protocol-sync.prose.md`.

### Invariants

- `drift` ніколи не містить false positive: кожен запис має бути підкріплений
  конкретним файлом + рядком коду.
- Якщо `drift` порожній, то `doc_outdated` також має бути `false` — код без дрифту
  але з застарілою документацією все одно вважається несинхронізованим.
