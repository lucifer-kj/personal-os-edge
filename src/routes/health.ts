import { Hono } from "hono";
import { Bindings } from "../types/env";
import { EdgeSupabaseClient } from "../lib/supabase";

export const healthRouter = new Hono<{ Bindings: Bindings }>();

healthRouter.get("/", async (c) => {
  const startTime = Date.now();
  const supabase = new EdgeSupabaseClient(c.env);

  let supabaseStatus = "unknown";
  let supabaseLatencyMs = 0;

  try {
    const t0 = Date.now();
    const { error } = await supabase.query("auth_sessions?limit=1&select=id");
    supabaseLatencyMs = Date.now() - t0;
    supabaseStatus = error ? "degraded" : "healthy";
  } catch {
    supabaseStatus = "unreachable";
  }

  return c.json({
    status: "healthy",
    service: "personal-os-edge",
    environment: c.env.ENVIRONMENT || "production",
    timestamp: new Date().toISOString(),
    uptime_ms: Date.now() - startTime,
    cloud: "Cloudflare Workers",
    ai_binding: !!c.env.AI,
    supabase: {
      status: supabaseStatus,
      latency_ms: supabaseLatencyMs,
    },
  });
});
