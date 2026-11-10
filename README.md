# Personal OS — Edge Backend (`personal-os-edge`)

> **Role in Duo-Repo System:** High-performance, zero-maintenance Serverless Backend for Personal OS running on **Cloudflare Workers**.  
> **Key Capabilities:** Edge GPU Whisper Voice Transcription, Lead Ingestion Webhook Gateway, Model Context Protocol (MCP) Server for external n8n AI agents, and Outbox Webhook Hub.

---

## 1. Architecture & Capabilities

* **Framework:** [Hono v4](https://hono.dev/) on Cloudflare Workers (TypeScript, zero-dependency, boots in 0ms).
* **Edge Whisper Voice Engine:** `POST /api/v1/voice/transcribe` streams audio directly to Cloudflare Workers AI (`@cf/openai/whisper`), transcribing in ~500ms and dispatching the transcript directly to your n8n autonomous AI agent webhook.
* **Lead Webhook Ingestion:** `POST /api/v1/leads/webhook` receives inbound leads from Apollo, Hunter, Webflow, or scrapers, deduplicates on `(user_id, email)`, scores the lead, and stores it in `public.leads`.
* **Model Context Protocol (MCP) Server:** `GET /mcp/sse` and `POST /mcp/messages` expose 6 typed tools to external **n8n AI agents** over Streamable HTTP / Server-Sent Events (SSE).

---

## 2. Environment Variables & Cloudflare Secrets

Configure the following secrets in Cloudflare Workers using Wrangler:

```bash
# Add your Supabase Service Role Key (from Supabase Dashboard -> Project Settings -> API)
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY

# Add your Master Enclave Secret Key (a strong random token for server-to-server calls)
npx wrangler secret put ENCLAVE_SECRET_KEY

# (Optional) Add your external n8n Webhook URL and API Key
npx wrangler secret put N8N_WEBHOOK_URL
npx wrangler secret put N8N_API_KEY
```

---

## 3. Local Development & Deployment

```bash
# Install dependencies
pnpm install

# Start local worker with Cloudflare AI bindings
pnpm dev

# Typecheck code
pnpm typecheck

# Deploy to Cloudflare Workers globally
pnpm deploy
```

---

## 4. API Endpoints Quick Reference

| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :--- |
| **GET** | `/health` | Live worker status & Supabase latency probe | None |
| **POST** | `/api/v1/voice/transcribe` | Multipart/raw audio transcription + classification | `Bearer pos_live_...` |
| **POST** | `/api/v1/leads/webhook` | Inbound lead ingestion from scrapers / Apollo | `X-Webhook-Secret` or Bearer |
| **GET** | `/api/v1/leads` | Cursor-paginated lead query for mobile & web | `Bearer pos_live_...` |
| **POST** | `/api/v1/leads/:id/convert`| Atomic conversion of lead to client project + task | `Bearer pos_live_...` |
| **GET** | `/mcp/sse` | MCP Server-Sent Events stream for n8n AI agent | `Bearer pos_live_...` |
| **POST** | `/mcp/messages` | JSON-RPC 2.0 tool execution for n8n AI agent | `Bearer pos_live_...` |
| **POST** | `/api/v1/n8n/dispatch` | Trigger external n8n automation workflow | `Bearer pos_live_...` |
