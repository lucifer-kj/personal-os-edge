import { Context, Next } from "hono";
import { Bindings, AuthenticatedContext } from "../types/env";
import { EdgeSupabaseClient } from "./supabase";

/**
 * Computes SHA-256 hash using Web Crypto API (supported natively in Cloudflare Workers)
 */
async function sha256(message: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function authMiddleware(requiredScope?: string) {
  return async (c: Context<{ Bindings: Bindings; Variables: { authContext: AuthenticatedContext } }>, next: Next) => {
    const authHeader = c.req.header("Authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Missing or malformed Authorization header" }, 401);
    }

    const token = authHeader.replace(/^Bearer\s+/, "").trim();
    const supabase = new EdgeSupabaseClient(c.env);
    const ownerId = await supabase.getOwnerUserId(c.env.ENCLAVE_OWNER_EMAIL);

    // 1. Check Master Enclave Secret Key
    if (c.env.ENCLAVE_SECRET_KEY && token === c.env.ENCLAVE_SECRET_KEY) {
      c.set("authContext", {
        userId: ownerId,
        tokenName: "master_enclave_key",
        scopes: ["*"],
      });
      return next();
    }

    // 2. Check Scoped API Token (e.g. pos_live_...)
    if (token.startsWith("pos_live_") || token.length >= 32) {
      const tokenHash = await sha256(token);

      const { data: rows, error } = await supabase.query<any[]>(
        `api_tokens?token_hash=eq.${tokenHash}&revoked_at=is.null&select=*`
      );

      if (!error && rows && rows.length > 0) {
        const tokenRecord = rows[0];

        // Check expiration
        if (tokenRecord.expires_at && new Date(tokenRecord.expires_at) < new Date()) {
          return c.json({ error: "API token has expired" }, 401);
        }

        // Check scope
        const tokenScopes: string[] = tokenRecord.scopes || [];
        if (requiredScope && !tokenScopes.includes("*") && !tokenScopes.includes(requiredScope)) {
          return c.json({ error: `Insufficient permissions. Required scope: ${requiredScope}` }, 403);
        }

        // Fire non-blocking touch to update last_used_at
        c.executionCtx.waitUntil(
          supabase.query(`api_tokens?id=eq.${tokenRecord.id}`, {
            method: "PATCH",
            body: JSON.stringify({ last_used_at: new Date().toISOString() }),
          })
        );

        c.set("authContext", {
          userId: tokenRecord.user_id,
          tokenId: tokenRecord.id,
          tokenName: tokenRecord.name,
          scopes: tokenScopes,
        });

        return next();
      }
    }

    return c.json({ error: "Invalid or revoked API token" }, 401);
  };
}
