import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { Bindings, AuthenticatedContext } from "./types/env";
import { healthRouter } from "./routes/health";
import { voiceRouter } from "./routes/voice";
import { leadsRouter } from "./routes/leads";
import { mcpRouter } from "./routes/mcp";
import { n8nRouter } from "./routes/n8n";

const app = new Hono<{
  Bindings: Bindings;
  Variables: { authContext: AuthenticatedContext };
}>();

// 1. Global Middleware
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin) => {
      // Allow localhost for dev, personal-os domain, and capacitor mobile shells
      if (!origin || origin.includes("localhost") || origin.includes("vercel.app") || origin.includes("capacitor://")) {
        return origin || "*";
      }
      return origin;
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Webhook-Secret", "X-N8N-API-KEY"],
    exposeHeaders: ["Content-Length", "X-Request-Id"],
    maxAge: 86400,
    credentials: true,
  })
);

// 2. Global Error Handler
app.onError((err, c) => {
  console.error("Unhandled Worker Exception:", err);
  return c.json(
    {
      error: "Internal Server Error",
      message: err.message,
      environment: c.env.ENVIRONMENT || "production",
    },
    500
  );
});

// 3. Mount Routers
app.route("/health", healthRouter);
app.route("/api/v1/voice", voiceRouter);
app.route("/api/v1/leads", leadsRouter);
app.route("/mcp", mcpRouter);
app.route("/api/v1/n8n", n8nRouter);

// 4. Root Endpoint
app.get("/", (c) => {
  return c.json({
    service: "personal-os-edge",
    status: "online",
    runtime: "Cloudflare Workers",
    version: "1.0.0",
    docs: {
      health: "/health",
      voice: "POST /api/v1/voice/transcribe",
      leads_webhook: "POST /api/v1/leads/webhook",
      mcp_sse: "GET /mcp/sse",
      mcp_messages: "POST /mcp/messages",
    },
  });
});

export default app;
