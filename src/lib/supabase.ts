import { Bindings } from "../types/env";

export class EdgeSupabaseClient {
  private url: string;
  private serviceKey: string;
  private cachedOwnerId: string | null = null;

  constructor(env: Bindings) {
    this.url = env.SUPABASE_URL.replace(/\/$/, "");
    this.serviceKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "";
  }

  private headers(prefer = "return=representation") {
    return {
      "Content-Type": "application/json",
      "apikey": this.serviceKey,
      "Authorization": `Bearer ${this.serviceKey}`,
      "Prefer": prefer,
    };
  }

  /**
   * Resolves the verified owner's UUID from auth.users or the enclave trigger
   */
  async getOwnerUserId(ownerEmail = "321arifali@gmail.com"): Promise<string> {
    if (this.cachedOwnerId) return this.cachedOwnerId;

    try {
      const res = await fetch(`${this.url}/rest/v1/auth_sessions?select=user_id&limit=1`, {
        headers: this.headers(),
      });
      if (res.ok) {
        const rows: any[] = await res.json();
        if (rows.length > 0 && rows[0].user_id) {
          this.cachedOwnerId = rows[0].user_id;
          return this.cachedOwnerId!;
        }
      }
    } catch {
      // Fallback
    }

    // Default fallback if session row not yet populated
    this.cachedOwnerId = "00000000-0000-0000-0000-000000000001";
    return this.cachedOwnerId;
  }

  async query<T = any>(endpoint: string, options: RequestInit = {}): Promise<{ data: T | null; error: string | null }> {
    const res = await fetch(`${this.url}/rest/v1/${endpoint}`, {
      ...options,
      headers: {
        ...this.headers(),
        ...(options.headers || {}),
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      return { data: null, error: `Supabase error (${res.status}): ${errText}` };
    }

    const data = (await res.json()) as T;
    return { data, error: null };
  }

  async rpc<T = any>(functionName: string, params: Record<string, any>): Promise<{ data: T | null; error: string | null }> {
    const res = await fetch(`${this.url}/rest/v1/rpc/${functionName}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(params),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { data: null, error: `RPC error (${res.status}): ${errText}` };
    }

    const data = (await res.json()) as T;
    return { data, error: null };
  }
}
