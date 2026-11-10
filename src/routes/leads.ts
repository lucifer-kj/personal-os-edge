import { Hono } from "hono";
import { z } from "zod";
import { Bindings, AuthenticatedContext } from "../types/env";
import { authMiddleware } from "../lib/auth";
import { EdgeSupabaseClient } from "../lib/supabase";

export const leadsRouter = new Hono<{
  Bindings: Bindings;
  Variables: { authContext: AuthenticatedContext };
}>();

const InboundLeadSchema = z.object({
  full_name: z.string().min(1),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  email: z.string().email(),
  phone: z.string().optional(),
  company: z.string().optional(),
  job_title: z.string().optional(),
  website: z.string().url().optional(),
  linkedin_url: z.string().url().optional(),
  location: z.string().optional(),
  source: z.enum(["apollo", "hunter", "linkedin", "website", "inbound_email", "referral", "manual", "n8n_scraper"]).default("apollo"),
  estimated_value_cents: z.number().int().nonnegative().default(0),
  enrichment_data: z.record(z.unknown()).default({}),
  notes: z.string().optional(),
});

/**
 * Public Webhook Receiver for Scrapers & Lead Generators (Apollo, Webflow, n8n)
 */
leadsRouter.post("/webhook", async (c) => {
  const supabase = new EdgeSupabaseClient(c.env);
  const ownerId = await supabase.getOwnerUserId(c.env.ENCLAVE_OWNER_EMAIL);

  // Check auth: Bearer Token or Header Secret
  const authHeader = c.req.header("Authorization") || "";
  const webhookSecret = c.req.header("X-Webhook-Secret") || "";
  const isValidAuth =
    (c.env.ENCLAVE_SECRET_KEY && (authHeader.endsWith(c.env.ENCLAVE_SECRET_KEY) || webhookSecret === c.env.ENCLAVE_SECRET_KEY)) ||
    authHeader.startsWith("Bearer pos_live_");

  if (!isValidAuth) {
    return c.json({ error: "Unauthorized webhook payload" }, 401);
  }

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Malformed JSON payload" }, 400);
  }

  const parsed = InboundLeadSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.issues }, 400);
  }

  const lead = parsed.data;

  // Calculate Lead Score (Heuristic: +30 for email, +20 for company, +20 for phone, +15 for title)
  let score = 20;
  if (lead.company) score += 25;
  if (lead.phone) score += 20;
  if (lead.linkedin_url) score += 15;
  if (lead.job_title && /(founder|ceo|director|head|vp|owner)/i.test(lead.job_title)) score += 20;
  score = Math.min(100, score);

  // Check if lead already exists by normalized email
  const { data: existingLeads } = await supabase.query<any[]>(
    `leads?user_id=eq.${ownerId}&email=eq.${encodeURIComponent(lead.email)}&select=id,status,enrichment_data`
  );

  let leadRecord: any = null;
  let actionTaken = "created";

  if (existingLeads && existingLeads.length > 0) {
    // Lead exists: merge enrichment data without overwriting human-set status
    actionTaken = "updated";
    const existing = existingLeads[0];
    const mergedEnrichment = {
      ...(existing.enrichment_data || {}),
      ...lead.enrichment_data,
      last_enriched_at: new Date().toISOString(),
    };

    const { data: updated } = await supabase.query(`leads?id=eq.${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        company: lead.company || undefined,
        phone: lead.phone || undefined,
        job_title: lead.job_title || undefined,
        linkedin_url: lead.linkedin_url || undefined,
        enrichment_data: mergedEnrichment,
        updated_at: new Date().toISOString(),
      }),
    });
    leadRecord = updated?.[0] || existing;
  } else {
    // Insert new lead
    const { data: inserted, error: insertErr } = await supabase.query("leads", {
      method: "POST",
      body: JSON.stringify({
        user_id: ownerId,
        full_name: lead.full_name,
        first_name: lead.first_name || lead.full_name.split(" ")[0],
        last_name: lead.last_name || lead.full_name.split(" ").slice(1).join(" ") || null,
        email: lead.email.toLowerCase().trim(),
        phone: lead.phone || null,
        company: lead.company || null,
        job_title: lead.job_title || null,
        website: lead.website || null,
        linkedin_url: lead.linkedin_url || null,
        location: lead.location || null,
        source: lead.source,
        score,
        estimated_value_cents: lead.estimated_value_cents,
        enrichment_data: lead.enrichment_data,
        notes: lead.notes || null,
        status: "lead",
      }),
    });

    if (insertErr) {
      return c.json({ error: `Failed to insert lead: ${insertErr}` }, 500);
    }
    leadRecord = inserted?.[0] || inserted;
  }

  // Log Activity
  if (leadRecord?.id) {
    c.executionCtx.waitUntil(
      supabase.query("lead_activities", {
        method: "POST",
        body: JSON.stringify({
          user_id: ownerId,
          lead_id: leadRecord.id,
          activity_type: "enrichment",
          summary: `Lead ${actionTaken} via ${lead.source} webhook`,
          details: { source: lead.source, score },
        }),
      })
    );

    // Trigger n8n Automated Outreach / Enrichment Workflow if configured
    if (c.env.N8N_WEBHOOK_URL) {
      c.executionCtx.waitUntil(
        fetch(c.env.N8N_WEBHOOK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Personal-OS-Event": "lead.ingested",
            ...(c.env.N8N_API_KEY ? { "X-N8N-API-KEY": c.env.N8N_API_KEY } : {}),
          },
          body: JSON.stringify({
            event: "lead.ingested",
            action: actionTaken,
            lead: leadRecord,
            timestamp: new Date().toISOString(),
          }),
        }).catch(() => {})
      );
    }
  }

  return c.json({
    success: true,
    action: actionTaken,
    lead_id: leadRecord?.id,
    lead: leadRecord,
  }, actionTaken === "created" ? 201 : 200);
});

// Authenticated Endpoints for Mobile App & Web
leadsRouter.use("/*", authMiddleware("leads:read"));

/**
 * List Leads (Ultra-lean cursor pagination <20KB)
 */
leadsRouter.get("/", async (c) => {
  const auth = c.get("authContext");
  const supabase = new EdgeSupabaseClient(c.env);

  const status = c.req.query("status");
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query("limit") || "20", 10)));
  const cursor = c.req.query("cursor"); // created_at ISO string

  let queryUrl = `leads?user_id=eq.${auth.userId}&archived_at=is.null&order=created_at.desc&limit=${limit + 1}`;
  if (status) queryUrl += `&status=eq.${encodeURIComponent(status)}`;
  if (cursor) queryUrl += `&created_at=lt.${encodeURIComponent(cursor)}`;

  queryUrl += `&select=id,full_name,company,job_title,email,phone,status,score,estimated_value_cents,created_at`;

  const { data: rows, error } = await supabase.query<any[]>(queryUrl);
  if (error) return c.json({ error }, 500);

  const leads = rows || [];
  const hasMore = leads.length > limit;
  const sliced = hasMore ? leads.slice(0, limit) : leads;
  const nextCursor = hasMore && sliced.length > 0 ? sliced[sliced.length - 1].created_at : null;

  return c.json({
    data: sliced,
    meta: {
      has_more: hasMore,
      next_cursor: nextCursor,
      limit,
    },
  });
});

/**
 * Convert Lead to Client Project & Kickoff Task (Atomic RPC)
 */
leadsRouter.post("/:id/convert", authMiddleware("leads:write"), async (c) => {
  const auth = c.get("authContext");
  const leadId = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const supabase = new EdgeSupabaseClient(c.env);

  const { data, error } = await supabase.rpc("convert_lead_to_project_and_task", {
    p_user_id: auth.userId,
    p_lead_id: leadId,
    p_project_name: body.project_name || null,
    p_project_description: body.project_description || null,
    p_estimated_value_cents: body.estimated_value_cents || null,
  });

  if (error) return c.json({ error }, 500);
  return c.json(data);
});
