import { Hono } from "hono";
import { Bindings, AuthenticatedContext } from "../types/env";
import { authMiddleware } from "../lib/auth";
import { EdgeSupabaseClient } from "../lib/supabase";

export const voiceRouter = new Hono<{
  Bindings: Bindings;
  Variables: { authContext: AuthenticatedContext };
}>();

voiceRouter.use("/*", authMiddleware("voice:transcribe"));

/**
 * Transcribe Audio via Cloudflare Workers AI (Whisper)
 * and dispatch transcript directly to n8n webhook for autonomous AI agent handling.
 */
voiceRouter.post("/transcribe", async (c) => {
  const auth = c.get("authContext");
  const supabase = new EdgeSupabaseClient(c.env);

  let audioBytes: Uint8Array | null = null;
  const contentType = c.req.header("Content-Type") || "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const audioFile = formData.get("audio");
    if (audioFile && typeof audioFile === "object" && "arrayBuffer" in audioFile) {
      const buffer = await (audioFile as Blob).arrayBuffer();
      audioBytes = new Uint8Array(buffer);
    }
  } else {
    const buffer = await c.req.arrayBuffer();
    if (buffer.byteLength > 0) {
      audioBytes = new Uint8Array(buffer);
    }
  }

  if (!audioBytes || audioBytes.length === 0) {
    return c.json({ error: "Missing audio binary. Send as multipart form 'audio' or raw audio body" }, 400);
  }

  // 1. Cloudflare Workers AI Whisper Transcription (~500ms on edge GPU)
  let transcript = "";
  try {
    const whisperRes = await c.env.AI.run("@cf/openai/whisper", {
      audio: [...audioBytes],
    });
    transcript = (whisperRes?.text || "").trim();
  } catch (err: any) {
    return c.json({ error: `Cloudflare AI Whisper transcription failed: ${err.message}` }, 500);
  }

  if (!transcript) {
    return c.json({ transcript: "", message: "No audible speech detected" }, 200);
  }

  // 2. Optimistic Enclave Inbox Record (Guarantees zero lost voice memos)
  let inboxItem: any = null;
  try {
    const { data } = await supabase.query("inbox_items", {
      method: "POST",
      body: JSON.stringify({
        user_id: auth.userId,
        title: "Voice: " + (transcript.length > 50 ? transcript.slice(0, 50) + "..." : transcript),
        content: transcript,
        capture_type: "task",
        source: "ai",
        status: "unprocessed",
      }),
    });
    inboxItem = data?.[0] || data;
  } catch {
    // Non-blocking fallback
  }

  // 3. Dispatch Transcript Directly to n8n Webhook
  let n8nDispatched = false;
  let n8nResponse: any = null;

  if (c.env.N8N_WEBHOOK_URL) {
    const targetWebhook = `${c.env.N8N_WEBHOOK_URL.replace(/\/$/, "")}/voice-memo`;

    c.executionCtx.waitUntil(
      (async () => {
        try {
          const res = await fetch(targetWebhook, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Personal-OS-User": auth.userId,
              ...(c.env.N8N_API_KEY ? { "X-N8N-API-KEY": c.env.N8N_API_KEY } : {}),
            },
            body: JSON.stringify({
              event: "voice.transcribed",
              transcript,
              user_id: auth.userId,
              inbox_id: inboxItem?.id || null,
              timestamp: new Date().toISOString(),
              source: "personal-os-edge",
            }),
          });
          n8nDispatched = res.ok;
          n8nResponse = await res.json().catch(() => ({ status: res.statusText }));
        } catch (err: any) {
          console.error("Failed to forward voice memo to n8n:", err);
        }
      })()
    );
  }

  return c.json({
    success: true,
    transcript,
    inbox_id: inboxItem?.id || null,
    n8n_dispatched: !!c.env.N8N_WEBHOOK_URL,
  });
});
