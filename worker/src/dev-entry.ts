/**
 * void Worker — local dev entry point.
 *
 * Wrangler dev / wrangler dev --config wrangler.dev.jsonc uses
 * THIS file as `main`. Production uses `src/index.ts` (via
 * wrangler.jsonc). The dev module is physically absent from the
 * production bundle because `src/index.ts` does not import this
 * file or any of the dev-only routes it registers.
 *
 * What this entry does:
 *   1. Imports the production app from `./index`.
 *   2. Re-exports the DO class (VoidCell) so wrangler can wire it
 *      into the DO binding declared in wrangler.dev.jsonc.
 *   3. Registers the dev-only auth bypass route.
 *   4. Wraps the default `fetch` handler so the landing-page
 *      response gets the dev-login button injected. We do this by
 *      intercepting the Response (instead of via Hono middleware)
 *      because Hono's `app.use()` only applies to routes added
 *      AFTER the middleware — and all the prod routes are added
 *      during the `./index` import.
 */
import { app } from "./index";
import { VoidCell } from "./void-cell";
import { handleDevLogin, devAuthButtonHtml, DEV_AUTH_BUTTON_MARKER } from "./auth-dev";

// Dev-only auth bypass. Never available in production.
app.post("/api/auth/dev-login", handleDevLogin);

// Wrap the default fetch handler to inject the dev-login button
// into the landing page. Only the response body is touched — the
// dev-login route itself (above) is the actual security boundary
// (it returns 404 if VOID_DEV_AUTH is not "1"/"true").
const originalFetch = app.fetch.bind(app);
app.fetch = async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
	const response = await originalFetch(request, env, ctx);
	const url = new URL(request.url);
	if (
		request.method === "GET" &&
		url.pathname === "/" &&
		response.headers.get("content-type")?.includes("text/html")
	) {
		const text = await response.text();
		if (text.includes(DEV_AUTH_BUTTON_MARKER)) {
			const replaced = text.replace(DEV_AUTH_BUTTON_MARKER, devAuthButtonHtml);
			return new Response(replaced, response);
		}
	}
	return response;
};

export { VoidCell };
export default app;
