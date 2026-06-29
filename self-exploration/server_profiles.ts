/**
 * Per-server profiles — the ONLY place server-specific context lives.
 *
 * The shared prompts (prompts.ts) stay domain-general; anything specific to one
 * MCP server (its disposable seed/setup, its safety rules) is gated here so a
 * given exploration run sees ONLY its own server's information — postgres sees
 * the postgres seed table + SQL/ACL safety, reddit sees reddit, etc. An unknown
 * server falls back to a generic, domain-neutral profile.
 */

export interface ServerProfile {
  /** What disposable test state is already in place (or how to make one) for
   *  the verify agent to mutate. */
  seed: string;
  /** Server-specific SAFETY rules for the verify agent (what it must never
   *  touch, and what to do if a reversal would require an unsafe op). */
  safety: string;
  /** OPTIONAL re-seed hook: the MCP tool call that re-creates a known sandbox
   *  state before each verify pass runs (issued through the live MCP). Absent
   *  for servers without a programmatic reset (e.g. HTTP/browser) — those let
   *  the verify agent seed its own throwaway items instead. */
  reset?: { tool: string; args: Record<string, unknown> };
}

/** Generic, domain-neutral profile for any server without a specific entry. */
const DEFAULT_PROFILE: ServerProfile = {
  seed: `Create your own throwaway item to test against (prefix any name you choose with "chats_probe_") — do not reuse pre-existing real data.`,
  safety: `SAFETY (the target may be shared infrastructure):
  - Operate ONLY on throwaway items YOU create (prefix "chats_probe_"). Never touch existing or real-looking data.
  - NEVER modify other users, permissions/credentials, or global/system settings — that can break the service for everyone.
  - If a proposed reversal would require any of the above to test, mark verdict "delete" with the reason "unsafe to test".`,
};

/** Server-specific overrides. Keyed by the MCP server name (as in the runner's
 *  config / serverFromToolName). Add an entry per server you explore. */
const PROFILES: Record<string, ServerProfile> = {
  postgres: {
    seed: `A fresh seeded table is ALREADY in place for you to mutate: chats_probe_seed(id serial pk, name text, status text) with 3 rows (alpha/active, beta/active, gamma/inactive). Test the destructive op + reversal against THIS table (or another chats_probe_* item you create).`,
    safety: `SAFETY (critical — the database is shared infrastructure):
  - Operate ONLY on throwaway items prefixed "chats_probe_" (the seeded table is one). Never touch existing real data, tables, or schemas.
  - NEVER modify authentication or access: no ALTER USER/ROLE, CREATE/DROP ROLE, GRANT/REVOKE, password changes, pg_hba, or system catalogs. Doing so will break the connection for everyone.
  - If a proposed reversal would require any of the above to test, mark verdict "delete" with the reason "unsafe to test".`,
    reset: {
      tool: "execute_sql",
      args: { sql: "DROP TABLE IF EXISTS chats_probe_seed; CREATE TABLE chats_probe_seed(id serial primary key, name text, status text); INSERT INTO chats_probe_seed(name,status) VALUES ('alpha','active'),('beta','active'),('gamma','inactive');" },
    },
  },
};

/** Resolve the profile for a server — its own entry, or the generic fallback. */
export function serverProfile(server: string): ServerProfile {
  return PROFILES[server] ?? DEFAULT_PROFILE;
}
