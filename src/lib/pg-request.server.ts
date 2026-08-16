/**
 * Request-scoped PostgreSQL clients.
 *
 * Cloudflare Workers forbid using an I/O object (socket, stream, request or
 * response body) created while handling one request from the handler of a
 * different request. A module-level connection pool violates that rule and
 * produces:
 *
 *   "Cannot perform I/O on behalf of a different request."
 *
 * Every client handed out here is therefore bound to the request that asked
 * for it (via a WeakMap keyed by the current `Request`), so two concurrent
 * students never share a socket. Within one request the client is reused, so a
 * handler that runs several queries still opens only one connection.
 */
import postgres from "postgres";
import { getRequest } from "@tanstack/react-start/server";

export type PgClient = {
  unsafe: (query: string, parameters?: unknown[]) => Promise<Record<string, unknown>[]>;
};

/** Per-request client registry. Entries disappear with the request object. */
const perRequest = new WeakMap<object, Map<string, PgClient>>();

/**
 * Connection strings whose idempotent DDL has already been applied in this
 * isolate. Only plain strings are cached here — never a promise or any other
 * request-scoped I/O object.
 */
const ddlApplied = new Set<string>();

export function ddlAlreadyApplied(key: string): boolean {
  return ddlApplied.has(key);
}

export function markDdlApplied(key: string): void {
  ddlApplied.add(key);
}

export function forgetDdl(key: string): void {
  ddlApplied.delete(key);
}

function createClient(url: string): PgClient {
  return postgres(url, {
    max: 1,
    idle_timeout: 10,
    connect_timeout: 8,
    prepare: false,
    onnotice: () => {},
  }) as unknown as PgClient;
}

function currentRequest(): object | null {
  try {
    return (getRequest() as unknown as object) ?? null;
  } catch {
    // Outside a request context (startup, background task): no sharing at all.
    return null;
  }
}

/**
 * Returns a PostgreSQL client that is safe to use in the current request.
 * Never store the returned client in module scope or pass it to another
 * request's handler.
 */
export function requestPg(url: string): PgClient {
  const request = currentRequest();
  if (!request) return createClient(url);

  let clients = perRequest.get(request);
  if (!clients) {
    clients = new Map<string, PgClient>();
    perRequest.set(request, clients);
  }
  const existing = clients.get(url);
  if (existing) return existing;

  const client = createClient(url);
  clients.set(url, client);
  return client;
}

/** Short-lived client for one-off checks (never cached, never shared). */
export function throwawayPg(url: string): PgClient {
  return postgres(url, {
    max: 1,
    idle_timeout: 2,
    connect_timeout: 8,
    prepare: false,
    onnotice: () => {},
  }) as unknown as PgClient;
}
