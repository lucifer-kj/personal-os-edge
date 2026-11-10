export interface Bindings {
  AI: any; // Cloudflare Workers AI Binding
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_JWKS_URL?: string;
  ENCLAVE_SECRET_KEY: string; // Master static fallback secret
  ENCLAVE_OWNER_EMAIL: string;
  ENVIRONMENT: string;
  N8N_WEBHOOK_URL?: string;
  N8N_API_KEY?: string;
}

export interface AuthenticatedContext {
  userId: string;
  tokenId?: string;
  tokenName?: string;
  scopes: string[];
}
