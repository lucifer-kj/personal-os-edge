import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Bindings, AuthenticatedContext } from "../types/env";
import { authMiddleware } from "../lib/auth";
import { EdgeSupabaseClient } from "../lib/supabase";

export const mcpRouter = new Hono<{
  Bindings: Bindings;
  Variables: { authContext: AuthenticatedContext };
}>();

mcpRouter.use("/*", authMiddleware("mcp:agent"));

// In-memory active SSE message response queues keyed by sessionId
const activeSessions = new Map<string, { send: (event: string, data: string) => void }>();

/**
 * 1. SSE Connection Endpoint for External n8n Agents & Copilots
 */
mcpRouter.get("/sse", async (c) => {
  const sessionId = crypto.randomUUID();

  return streamSSE(c, async (stream) => {
    // Register active session
    activeSessions.set(sessionId, {
      send: (event, data) => stream.writeSSE({ event, data }),
    });

    // Send initial endpoint announcement required by MCP spec
    await stream.writeSSE({
      event: "endpoint",
      data: `/mcp/messages?sessionId=${sessionId}`,
    });

    // Keep connection alive with periodic heartbeat
    const interval = setInterval(async () => {
      try {
        await stream.writeSSE({ event: "ping", data: "heartbeat" });
      } catch {
        clearInterval(interval);
      }
    }, 25000);

    // Keep connection stream open
    stream.onAbort(() => {
      clearInterval(interval);
      activeSessions.delete(sessionId);
    });

    // Hold connection
    while (!stream.aborted) {
      await stream.sleep(1000);
    }
  });
});

/**
 * 2. JSON-RPC 2.0 Message Dispatcher
 */
mcpRouter.post("/messages", async (c) => {
  const auth = c.get("authContext");
  const supabase = new EdgeSupabaseClient(c.env);
  const sessionId = c.req.query("sessionId");

  let rpc: any;
  try {
    rpc = await c.req.json();
  } catch {
    return c.json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, 400);
  }

  const { method, params, id } = rpc;

  // Handler for MCP 'initialize'
  if (method === "initialize") {
    const initResponse = {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: "personal-os-edge-mcp",
          version: "1.0.0",
        },
      },
    };

    if (sessionId && activeSessions.has(sessionId)) {
      activeSessions.get(sessionId)?.send("message", JSON.stringify(initResponse));
    }
    return c.json(initResponse);
  }

  // Handler for 'tools/list'
  if (method === "tools/list") {
    const listResponse = {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "lead_search",
            description: "Search CRM leads by status, company, score, or keyword query.",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string", description: "Search query across name, company, email" },
                status: { type: "string", enum: ["lead", "contacted", "qualified", "converted", "lost"] },
                limit: { type: "integer", default: 10 },
              },
            },
          },
          {
            name: "crm_log_activity",
            description: "Log an email, phone call, meeting, or research note on a lead timeline.",
            inputSchema: {
              type: "object",
              required: ["lead_id", "activity_type", "summary"],
              properties: {
                lead_id: { type: "string", format: "uuid" },
                activity_type: { type: "string", enum: ["email_sent", "email_received", "call", "meeting", "note_added", "status_changed"] },
                summary: { type: "string" },
                details: { type: "object" },
              },
            },
          },
          {
            name: "lead_update_status",
            description: "Advance or update a lead's stage in the CRM pipeline.",
            inputSchema: {
              type: "object",
              required: ["lead_id", "status"],
              properties: {
                lead_id: { type: "string", format: "uuid" },
                status: { type: "string", enum: ["lead", "contacted", "qualified", "converted", "lost"] },
              },
            },
          },
          {
            name: "task_create",
            description: "Create a new scheduled task in Personal OS.",
            inputSchema: {
              type: "object",
              required: ["title"],
              properties: {
                title: { type: "string" },
                description: { type: "string" },
                priority: { type: "string", enum: ["low", "medium", "high", "urgent"], default: "medium" },
                due_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
              },
            },
          },
          {
            name: "calendar_check_schedule",
            description: "Check upcoming events and identify conflicting time blocks.",
            inputSchema: {
              type: "object",
              required: ["date"],
              properties: {
                date: { type: "string", description: "Date formatted YYYY-MM-DD" },
              },
            },
          },
          {
            name: "knowledge_search",
            description: "Full-text search across knowledge base notes and wiki links.",
            inputSchema: {
              type: "object",
              required: ["query"],
              properties: {
                query: { type: "string" },
                limit: { type: "integer", default: 10 },
              },
            },
          },
        ],
      },
    };

    if (sessionId && activeSessions.has(sessionId)) {
      activeSessions.get(sessionId)?.send("message", JSON.stringify(listResponse));
    }
    return c.json(listResponse);
  }

  // Handler for 'tools/call'
  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments || {};
    let toolResultText = "";
    let isError = false;

    try {
      if (toolName === "lead_search") {
        let q = `leads?user_id=eq.${auth.userId}&archived_at=is.null&limit=${args.limit || 10}&select=id,full_name,company,email,phone,status,score`;
        if (args.status) q += `&status=eq.${encodeURIComponent(args.status)}`;
        if (args.query) q += `&or=(full_name.ilike.%${encodeURIComponent(args.query)}%,company.ilike.%${encodeURIComponent(args.query)}%)`;

        const { data, error } = await supabase.query(q);
        if (error) throw new Error(error);
        toolResultText = JSON.stringify(data, null, 2);
      } else if (toolName === "crm_log_activity") {
        const { data, error } = await supabase.query("lead_activities", {
          method: "POST",
          body: JSON.stringify({
            user_id: auth.userId,
            lead_id: args.lead_id,
            activity_type: args.activity_type,
            summary: args.summary,
            details: args.details || {},
          }),
        });
        if (error) throw new Error(error);
        toolResultText = `Activity logged successfully for lead ${args.lead_id}`;
      } else if (toolName === "lead_update_status") {
        const { error } = await supabase.query(`leads?id=eq.${args.lead_id}&user_id=eq.${auth.userId}`, {
          method: "PATCH",
          body: JSON.stringify({ status: args.status, updated_at: new Date().toISOString() }),
        });
        if (error) throw new Error(error);
        toolResultText = `Lead ${args.lead_id} updated to status '${args.status}'`;
      } else if (toolName === "task_create") {
        const { data, error } = await supabase.query("tasks", {
          method: "POST",
          body: JSON.stringify({
            user_id: auth.userId,
            title: args.title,
            description: args.description || null,
            priority: args.priority || "medium",
            due_date: args.due_date || null,
            source_type: "ai",
            status: "todo",
          }),
        });
        if (error) throw new Error(error);
        toolResultText = `Task created with ID ${data?.[0]?.id || "ok"}`;
      } else if (toolName === "calendar_check_schedule") {
        const dateStr = args.date;
        const { data, error } = await supabase.query(
          `calendar_events?user_id=eq.${auth.userId}&start_time=gte.${dateStr}T00:00:00Z&start_time=lte.${dateStr}T23:59:59Z&select=id,title,start_time,end_time`
        );
        if (error) throw new Error(error);
        toolResultText = JSON.stringify(data || [], null, 2);
      } else if (toolName === "knowledge_search") {
        const { data, error } = await supabase.query(
          `notes?user_id=eq.${auth.userId}&deleted_at=is.null&or=(title.ilike.%${encodeURIComponent(args.query)}%,content.ilike.%${encodeURIComponent(args.query)}%)&limit=${args.limit || 10}&select=id,title,tags,created_at`
        );
        if (error) throw new Error(error);
        toolResultText = JSON.stringify(data || [], null, 2);
      } else {
        isError = true;
        toolResultText = `Unknown tool: ${toolName}`;
      }
    } catch (err: any) {
      isError = true;
      toolResultText = `Tool execution error: ${err.message}`;
    }

    const callResponse = {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: toolResultText }],
        isError,
      },
    };

    if (sessionId && activeSessions.has(sessionId)) {
      activeSessions.get(sessionId)?.send("message", JSON.stringify(callResponse));
    }
    return c.json(callResponse);
  }

  return c.json({ jsonrpc: "2.0", error: { code: -32601, message: "Method not found" }, id }, 404);
});
