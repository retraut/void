# Why Hono?

Current state: `worker/src/index.ts` is **262 lines** of hand-rolled routing with `if (path === ...)`, regex `path.match(...)`, manual CORS headers, and auth middleware duplicated at every entry point. It works. It's also brittle, repetitive, and hard to extend.

---

## Problem 1: Routing is manual and error-prone

```ts
// Current — 5 different patterns in one file:
if (path.startsWith("/cell/")) { ... }                    // prefix check
if (path === "/mcp") { ... }                              // exact match
if (path === "/health") { ... }                           // exact match
if (path.startsWith("/deployments/")) { ... }              // prefix + slice
const rotateMatch = path.match(/^\/servers\/([^/]+)\/rotate-session$/); // regex
```

Mix of `startsWith`, `===`, `match`, `pathname` — each with different edge-case behavior. Adding one route = reading 200+ lines to find the right if/else nesting. Route ordering matters (note: `/deployments/` vs `/deployments/:id` at lines 193 vs 200 — wrong order breaks routing).

**With Hono:**
```ts
app.get("/cell/:server_id", handleCellWs)
app.post("/cell/:server_id/send-deploy", handleSendDeploy)
app.get("/cell/:server_id/logs", handleLogs)
app.get("/cell/:server_id/status", handleStatus)
app.post("/cell/:server_id/rotate-session", handleRotateSession)
// — every route visible in one flat block, impossible to mis-order —
```

---

## Problem 2: Auth middleware handwritten and duplicated

Current: `requireBearer()` called 6 times manually across the file (lines 75, 94, 168, 232). Each call is followed by `if (authFail) return authFail`. Miss one — security hole.

```ts
// Current:
if (!isWsUpgrade) {
  const authFail = requireBearer(env, request);
  if (authFail) return authFail;
}
```

**With Hono:**
```ts
app.use("/api/*", async (c, next) => {
  const fail = requireBearer(c.env, c.req.raw);
  if (fail) return fail;
  await next();
});
// — one line, no chance to miss a route —
```

---

## Problem 3: CORS scattered in every response

Current: CORS preflight is a `method === "OPTIONS"` check with hardcoded `access-control-*` headers. Then `handleMcp()` manually sets `access-control-allow-origin` again. The `/cell/*` HTTP routes have **no CORS at all** — inconsistent.

```ts
// Current — 3 separate CORS locations:
// line 56: OPTIONS preflight
// line 86: handleMcp sets CORS
// line 97: auth failure sets CORS
```

**With Hono:**
```ts
import { cors } from "hono/cors";
app.use("/mcp", cors());
app.use("/health", cors());
// — done, consistent, testable —
```

---

## Problem 4: DO stub routing is string concatenation

```ts
// Current:
const parts = path.slice("/cell/".length).split("/");
const serverId = parts[0];
const subPath = "/" + parts.slice(1).join("/") + url.search;
const internalUrl = new URL("https://cell" + subPath);
const newRequest = new Request(internalUrl.toString(), request);
return cellStub.fetch(newRequest);
```

Every DO route needs this boilerplate. With Hono, extract once as middleware:

```ts
app.use("/cell/:serverId/*", async (c, next) => {
  const stub = c.env.void_cell.get(c.env.void_cell.idFromName(c.req.param("serverId")));
  return stub.fetch(c.req.raw); // forwards method/body/headers
});
```

---

## Problem 5: `env` type unsafety

```ts
// Current:
const cellId = env.void_cell.idFromName(serverId);
//   ^? any by default in DO stubs
```

Hono's typed env (`c.env.VOID_DB`) is checked at compile time. Wrangler already generates types via `wrangler types` — Hono reads them natively.

---

## Problem 6: Validation

Current: hand-written `validateRef`, `validateRepoUrl`, `validateShellCommand` called manually in every handler. Wired separately in `void-cell.ts`, `mcp.ts`, `webhook.ts` — three call sites for the same logic.

With Hono + Zod:
```ts
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

const deploySchema = z.object({
  repo_url: z.string().url().refine(validateRepoUrl),
  ref: z.string().regex(/^[a-zA-Z0-9._/+-]+$/).max(200),
  build_command: shellCommandSchema.optional(),
  serve_command: shellCommandSchema.optional(),
});

app.post("/cell/:serverId/send-deploy", zValidator("json", deploySchema), async (c) => {
  const body = c.req.valid("json"); // fully typed, validated
  // ...
});
```

Validation errors become structured 400 responses — no manual error handling.

---

## What Hono does NOT give us

- **WS upgrade** — Hono's WS helper is for `ws:` (standard WS), not CF Durable Object `WebSocketPair`. The DO upgrade path stays as-is.
- **SSE streams** — Hono Streaming API exists but doesn't simplify DO-to-SSE forwarding.
- **MCP** — Hono doesn't speak JSON-RPC 2.0. The MCP handler logic stays as-is.

These are ~20% of the code. The other 80% (REST, auth, routing) benefits directly.

---

## Migration effort estimation

| Step | Files touched | LoC changed | Risk |
|------|--------------|-------------|------|
| Install `hono`, `@hono/zod-validator` | `worker/package.json` | 2 | none |
| Rewrite `index.ts` with Hono router | `worker/src/index.ts` | 262 → ~120 | medium |
| Add `cors()` middleware, remove manual CORS | `worker/src/index.ts`, `mcp.ts` | ~30 removed | low |
| Add `bearerAuth` middleware, remove `requireBearer` calls | `worker/src/index.ts` | ~20 removed | low |
| Add Zod schemas for MCP/API inputs | `worker/src/schemas.ts` (new) | ~50 | low |
| Replace `validateXxx` calls with `zValidator` | `worker/src/index.ts`, `mcp.ts`, `webhook.ts` | ~40 changed | low |

**Total:** ~3 hours, zero behavioural change. No agent changes. No schema changes.

---

## Risk vs reward

- **Risk:** Low — Hono is a single dependency, widely used, CF Workers-native. Zero effect on agent or protocol.
- **Reward:** Every future route is 1 line instead of 5–10. Auth/CORS cannot be forgotten. Input validation is declarative. Env is typesafe. Code is halved (`262 → ~120` lines in index.ts).

---

## Conclusion

The current code works. But every route added today repeats the same boilerplate as the first route. Hono is not a framework rewrite — it's a **routing + middleware library** that removes the accidental complexity of vanilla Workers. The ROI compounds with every new endpoint.
