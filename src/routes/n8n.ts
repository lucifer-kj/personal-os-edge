import { Hono } from "hono";
import { Bindings, AuthenticatedContext } from "../types/env";
import { authMiddleware } from "../lib/auth";
import { EdgeSupabaseClient } from "../lib/supabase";

export const n8nRouter = new Hono<{
  Bindings: Bindings;
  Variables: { authContext: AuthenticatedContext };
}>();

n8nRouter.use("/*", authMiddleware("n8n:workflow"));

/**
 * Dispatch an Action or Trigger to an External n8n Workflow
 */
n8nRouter.post("/dispatch", async (c) => {
  const auth = c.get("authContext");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;

  const workflowSlug = body.workflow || "lead-enrichment";
  const payload = body.payload || {};

  if (!c.env.N8N_WEBHOOK_URL) {
    return c.json({ error: "N8N_WEBHOOK_URL is not configured on Cloudflare Workers" }, 500);
  }

  const targetUrl = `${c.env.N8N_WEBHOOK_URL.replace(/\/$/, "")}/${workflowSlug}`;

  try {
    const n8nRes = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Personal-OS-User": auth.userId,
        ...(c.env.N8N_API_KEY ? { "X-N8N-API-KEY": c.env.N8N_API_KEY } : {}),
      },
      body: JSON.stringify({
        ...payload,
        dispatched_by: auth.tokenName || "enclave_user",
        dispatched_at: new Date().toISOString(),
      }),
    });

    const responseData = await n8nRes.json().catch(() => ({ status: n8nRes.statusText }));

    return c.json({
      success: n8nRes.ok,
      status: n8nRes.status,
      workflow: workflowSlug,
      n8n_response: responseData,
    });
  } catch (err: any) {
    return c.json({ error: `Failed to trigger n8n workflow: ${err.message}` }, 502);
  }
});
