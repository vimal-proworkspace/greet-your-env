/**
 * Piston node pool — the multi-VM execution layer that sits *inside* the
 * existing execution router.
 *
 *   Student browser
 *     → existing CodeArena execution API (unchanged)
 *       → ExecutionRouter (exec-router.server.ts)
 *         → PistonPool  ├── piston-vm-1
 *                       ├── piston-vm-2
 *                       └── … (configuration only, no code change)
 *         → existing engines / Judge0 fallback (unchanged)
 *
 * Nothing here is importable by the browser: node URLs, health state and load
 * counters never leave the server except through the admin server functions,
 * which return plain serializable summaries only.
 *
 * Cloudflare-safe: every PostgreSQL client is request-scoped and every HTTP
 * body is consumed inside the call that created it.
 */
import { getConfig } from "./app-config.server";
import { ddlAlreadyApplied, forgetDdl, markDdlApplied, requestPg, type PgClient } from "./pg-request.server";
import {
  normalizeProviderBaseUrl,
  isEgressBlockedPort,
  describeEgressPortProblem,
  isDirectIpHost,
  describeDirectIpProblem,
} from "./exec-engines";

import {
  ExecutionServiceError,
  LanguageUnavailableError,
  providerJson,
  type ExecInput,
  type ExecResult,
} from "./exec-error.server";
import { pistonAdapter } from "./engine-adapters.server";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type NodeHealth = "ONLINE" | "UNHEALTHY" | "OFFLINE" | "DISABLED";

export type PistonNode = {
  id: string;
  nodeId: string;
  url: string;
  enabled: boolean;
  maxConcurrentJobs: number;
  healthStatus: NodeHealth;
  lastHealthCheck: string | null;
  lastError: string;
  failureCount: number;
  currentLoad: number;
  totalExecutions: number;
  totalFailures: number;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
};

export type PistonExecutionLog = {
  id: string;
  submissionId: string | null;
  studentId: string | null;
  roundId: string | null;
  assignedNodeId: string;
  actualNodeId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  retryCount: number;
  status: string;
  failureReason: string;
};

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

async function databaseUrl(): Promise<string> {
  const fromConfig = (await getConfig("OWN_SUPABASE_DB_URL")) ?? "";
  const url = (fromConfig || process.env["OWN_SUPABASE_DB_URL"] || "").trim();
  if (!url) throw new Error("The application is not connected to its database yet.");
  return url;
}

const DDL = `
create schema if not exists codearena_private;

create table if not exists codearena_private.piston_nodes (
  id uuid primary key default gen_random_uuid(),
  node_id text not null unique,
  url text not null,
  enabled boolean not null default true,
  max_concurrent_jobs integer not null default 20,
  timeout_ms integer not null default 20000,
  health_status text not null default 'OFFLINE',
  last_health_check timestamptz,
  last_error text not null default '',
  failure_count integer not null default 0,
  current_load integer not null default 0,
  total_executions integer not null default 0,
  total_failures integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists codearena_private.piston_assignments (
  student_id text not null,
  round_id text not null default '',
  node_id text not null,
  created_at timestamptz not null default now(),
  primary key (student_id, round_id)
);

create table if not exists codearena_private.piston_executions (
  id uuid primary key default gen_random_uuid(),
  submission_id text,
  student_id text,
  round_id text,
  assigned_node_id text not null default '',
  actual_node_id text not null default '',
  started_at timestamptz not null default now(),
  ended_at timestamptz not null default now(),
  duration_ms integer not null default 0,
  retry_count integer not null default 0,
  status text not null default '',
  failure_reason text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists piston_executions_created_idx on codearena_private.piston_executions (created_at desc);
`;

const DDL_KEY_SUFFIX = "#piston-pool";

async function schema(): Promise<PgClient> {
  const url = await databaseUrl();
  const client = requestPg(url);
  const key = url + DDL_KEY_SUFFIX;
  if (!ddlAlreadyApplied(key)) {
    try {
      await client.unsafe(DDL);
      markDdlApplied(key);
      await seedNodes(client);
      await repointBlockedPorts(client);
    } catch (error) {
      forgetDdl(key);
      throw error;
    }
  }
  return client;
}

function toNode(row: Record<string, unknown>): PistonNode {
  const enabled = Boolean(row["enabled"]);
  const status = String(row["health_status"] ?? "OFFLINE").toUpperCase() as NodeHealth;
  return {
    id: String(row["id"]),
    nodeId: String(row["node_id"]),
    url: String(row["url"] ?? ""),
    enabled,
    maxConcurrentJobs: Number(row["max_concurrent_jobs"] ?? 20),
    healthStatus: enabled ? status : "DISABLED",
    lastHealthCheck: row["last_health_check"] ? new Date(String(row["last_health_check"])).toISOString() : null,
    lastError: String(row["last_error"] ?? ""),
    failureCount: Number(row["failure_count"] ?? 0),
    currentLoad: Math.max(0, Number(row["current_load"] ?? 0)),
    totalExecutions: Number(row["total_executions"] ?? 0),
    totalFailures: Number(row["total_failures"] ?? 0),
    timeoutMs: Number(row["timeout_ms"] ?? 20_000),
    createdAt: new Date(String(row["created_at"] ?? new Date())).toISOString(),
    updatedAt: new Date(String(row["updated_at"] ?? new Date())).toISOString(),
  };
}

/** Default pool, overridable through the PISTON_NODES_JSON backend variable. */
const DEFAULT_NODES = [
  { id: "piston-vm-1", url: "http://148.113.52.23:8080", enabled: true, maxConcurrentJobs: 20 },
  { id: "piston-vm-2", url: "http://148.113.52.28:8080", enabled: true, maxConcurrentJobs: 20 },
];

function initialNodes(): { id: string; url: string; enabled: boolean; maxConcurrentJobs: number }[] {
  const raw = (process.env["PISTON_NODES_JSON"] ?? "").trim();
  if (!raw) return DEFAULT_NODES;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) return DEFAULT_NODES;
    return parsed
      .map((entry: Record<string, unknown>) => ({
        id: String(entry["id"] ?? "").trim(),
        url: String(entry["url"] ?? "").trim(),
        enabled: entry["enabled"] !== false,
        maxConcurrentJobs: Math.min(Math.max(Number(entry["maxConcurrentJobs"] ?? 20) || 20, 1), 200),
      }))
      .filter((entry) => entry.id && entry.url);
  } catch {
    console.error("[piston-pool] PISTON_NODES_JSON is not valid JSON — using the built-in pool");
    return DEFAULT_NODES;
  }
}

async function seedNodes(client: PgClient): Promise<void> {
  const rows = await client.unsafe("select count(*)::int as n from codearena_private.piston_nodes");
  if (Number(rows[0]?.["n"] ?? 0) > 0) return;
  for (const node of initialNodes()) {
    const normalized = normalizeProviderBaseUrl(node.url);
    if (!normalized.baseUrl) continue;
    await client.unsafe(
      `insert into codearena_private.piston_nodes (node_id, url, enabled, max_concurrent_jobs)
       values ($1,$2,$3,$4) on conflict (node_id) do nothing`,
      [node.id, normalized.baseUrl, node.enabled, node.maxConcurrentJobs],
    );
  }
  console.info("[piston-pool] seeded initial Piston nodes");
}

/**
 * One-time self-heal for pools seeded before the VMs were re-exposed: the
 * hosting environment cannot dial outbound port 2000, so any node still
 * pointing there is repointed to the routable 8080 listener of the same host.
 */
async function repointBlockedPorts(client: PgClient): Promise<void> {
  try {
    const rows = await client.unsafe(
      `update codearena_private.piston_nodes
          set url = replace(url, ':2000', ':8080'),
              health_status = 'OFFLINE',
              last_error = '',
              failure_count = 0,
              updated_at = now()
        where url like '%:2000%'
        returning node_id`,
    );
    if (rows.length) {
      console.info(`[piston-pool] repointed ${rows.length} node(s) from blocked port 2000 to 8080`);
    }
  } catch (err) {
    console.error("[piston-pool] could not repoint blocked-port nodes", err);
  }
}

export async function listNodes(): Promise<PistonNode[]> {
  const client = await schema();
  const rows = await client.unsafe("select * from codearena_private.piston_nodes order by node_id asc");
  return rows.map(toNode);
}

export async function getNode(id: string): Promise<PistonNode | null> {
  const client = await schema();
  const rows = await client.unsafe("select * from codearena_private.piston_nodes where id = $1", [id]);
  return rows[0] ? toNode(rows[0]) : null;
}

export type NodeInput = {
  nodeId: string;
  url: string;
  enabled: boolean;
  maxConcurrentJobs: number;
  timeoutMs?: number;
};

/**
 * Validates an admin-supplied node address. Only http(s) is accepted, the URL
 * must parse, and loopback / link-local / metadata addresses are refused so a
 * node entry can never be turned into an SSRF probe of the backend's own
 * network namespace.
 */
export function validateNodeUrl(raw: string): { url: string; error: string | null } {
  const normalized = normalizeProviderBaseUrl(raw);
  if (normalized.problem) {
    return {
      url: "",
      error:
        normalized.problem === "local_url"
          ? "localhost / 127.0.0.1 cannot be reached from the backend. Use the VM's routable address."
          : "Enter a valid Piston API URL, for example http://203.0.113.10:8080",
    };
  }
  let host = "";
  try {
    host = new URL(normalized.baseUrl).hostname.toLowerCase();
  } catch {
    return { url: "", error: "Enter a valid Piston API URL." };
  }
  if (/^(169\.254\.|::ffff:169\.254\.)/.test(host) || host === "metadata.google.internal") {
    return { url: "", error: "Link-local and cloud metadata addresses are not allowed." };
  }
  return { url: normalized.baseUrl, error: null };
}

export async function createNode(input: NodeInput): Promise<PistonNode> {
  const client = await schema();
  const rows = await client.unsafe(
    `insert into codearena_private.piston_nodes (node_id, url, enabled, max_concurrent_jobs, timeout_ms)
     values ($1,$2,$3,$4,$5) returning *`,
    [input.nodeId, input.url, input.enabled, input.maxConcurrentJobs, input.timeoutMs ?? 20_000],
  );
  return toNode(rows[0]!);
}

export async function updateNode(id: string, patch: Partial<NodeInput>): Promise<PistonNode | null> {
  const client = await schema();
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.nodeId !== undefined) push("node_id", patch.nodeId);
  if (patch.url !== undefined) push("url", patch.url);
  if (patch.enabled !== undefined) push("enabled", patch.enabled);
  if (patch.maxConcurrentJobs !== undefined) push("max_concurrent_jobs", patch.maxConcurrentJobs);
  if (patch.timeoutMs !== undefined) push("timeout_ms", patch.timeoutMs);
  sets.push("updated_at = now()");
  params.push(id);
  const rows = await client.unsafe(
    `update codearena_private.piston_nodes set ${sets.join(", ")} where id = $${params.length} returning *`,
    params,
  );
  return rows[0] ? toNode(rows[0]) : null;
}

/** Removes a node. Historical execution logs keep their actualNodeId. */
export async function deleteNode(id: string): Promise<boolean> {
  const client = await schema();
  const rows = await client.unsafe("delete from codearena_private.piston_nodes where id = $1 returning node_id", [id]);
  const nodeId = rows[0] ? String(rows[0]["node_id"]) : "";
  if (nodeId) {
    // Existing students are re-assigned on their next execution; execution
    // history is intentionally left untouched.
    await client.unsafe("delete from codearena_private.piston_assignments where node_id = $1", [nodeId]);
  }
  return rows.length > 0;
}

async function saveNodeHealth(
  nodeId: string,
  health: { status: NodeHealth; error: string; resetFailures?: boolean },
): Promise<void> {
  const client = await schema();
  await client.unsafe(
    `update codearena_private.piston_nodes
        set health_status = $1,
            last_error = $2,
            failure_count = case when $3 then 0 else failure_count end,
            last_health_check = now(),
            updated_at = now()
      where node_id = $4`,
    [health.status, health.error.slice(0, 500), Boolean(health.resetFailures), nodeId],
  );
}

async function noteFailure(nodeId: string, reason: string): Promise<void> {
  const client = await schema();
  await client.unsafe(
    `update codearena_private.piston_nodes
        set failure_count = failure_count + 1,
            total_failures = total_failures + 1,
            health_status = case when failure_count + 1 >= 2 then 'UNHEALTHY' else health_status end,
            last_error = $2,
            updated_at = now()
      where node_id = $1`,
    [nodeId, reason.slice(0, 500)],
  );
}

async function noteSuccess(nodeId: string): Promise<void> {
  const client = await schema();
  await client.unsafe(
    `update codearena_private.piston_nodes
        set total_executions = total_executions + 1,
            failure_count = 0,
            health_status = 'ONLINE',
            last_error = '',
            updated_at = now()
      where node_id = $1`,
    [nodeId],
  );
}

/** Bounded concurrency: claims a slot only when the node is below capacity. */
async function acquireSlot(nodeId: string): Promise<boolean> {
  const client = await schema();
  const rows = await client.unsafe(
    `update codearena_private.piston_nodes
        set current_load = current_load + 1, updated_at = now()
      where node_id = $1 and current_load < max_concurrent_jobs
      returning node_id`,
    [nodeId],
  );
  return rows.length > 0;
}

async function releaseSlot(nodeId: string): Promise<void> {
  try {
    const client = await schema();
    await client.unsafe(
      `update codearena_private.piston_nodes
          set current_load = greatest(current_load - 1, 0), updated_at = now()
        where node_id = $1`,
      [nodeId],
    );
  } catch (err) {
    console.error("[piston-pool] could not release capacity slot", err);
  }
}

async function logExecution(entry: Omit<PistonExecutionLog, "id">): Promise<void> {
  try {
    const client = await schema();
    await client.unsafe(
      `insert into codearena_private.piston_executions
         (submission_id, student_id, round_id, assigned_node_id, actual_node_id,
          started_at, ended_at, duration_ms, retry_count, status, failure_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        entry.submissionId,
        entry.studentId,
        entry.roundId,
        entry.assignedNodeId,
        entry.actualNodeId,
        entry.startedAt,
        entry.endedAt,
        entry.durationMs,
        entry.retryCount,
        entry.status,
        entry.failureReason.slice(0, 500),
      ],
    );
  } catch (err) {
    // Telemetry must never break a student's run.
    console.error("[piston-pool] could not persist execution log", err);
  }
}

export async function readExecutionLogs(limit = 50): Promise<PistonExecutionLog[]> {
  const client = await schema();
  const rows = await client.unsafe(
    `select * from codearena_private.piston_executions order by created_at desc limit $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((row) => ({
    id: String(row["id"]),
    submissionId: row["submission_id"] ? String(row["submission_id"]) : null,
    studentId: row["student_id"] ? String(row["student_id"]) : null,
    roundId: row["round_id"] ? String(row["round_id"]) : null,
    assignedNodeId: String(row["assigned_node_id"] ?? ""),
    actualNodeId: String(row["actual_node_id"] ?? ""),
    startedAt: new Date(String(row["started_at"])).toISOString(),
    endedAt: new Date(String(row["ended_at"])).toISOString(),
    durationMs: Number(row["duration_ms"] ?? 0),
    retryCount: Number(row["retry_count"] ?? 0),
    status: String(row["status"] ?? ""),
    failureReason: String(row["failure_reason"] ?? ""),
  }));
}

/* ------------------------------------------------------------------ */
/* Health checking                                                     */
/* ------------------------------------------------------------------ */

export const HEALTH_TIMEOUT_MS = 8_000;

export type NodeHealthResult = {
  nodeId: string;
  status: NodeHealth;
  latencyMs: number;
  runtimes: number;
  detail: string;
};

/**
 * Calls `GET {url}/api/v2/runtimes`, validating HTTP status, content type and
 * JSON shape. Only plain data is returned — the Response body is consumed by
 * `providerJson` inside the same call.
 */
export async function checkNode(node: PistonNode, persist = true): Promise<NodeHealthResult> {
  if (!node.enabled) {
    if (persist) await saveNodeHealth(node.nodeId, { status: "DISABLED", error: "" });
    return { nodeId: node.nodeId, status: "DISABLED", latencyMs: 0, runtimes: 0, detail: "Disabled by administrator." };
  }
  const started = Date.now();
  const finalUrl = `${node.url}/api/v2/runtimes`;
  console.info(
    `[piston-health] node=${node.nodeId} configuredUrl=${node.url} finalUrl=${finalUrl} method=GET headers=accept:application/json (no Authorization header is sent)`,
  );
  try {
    const payload = await providerJson(
      finalUrl,
      { method: "GET", headers: { accept: "application/json" } },
      node.timeoutMs || HEALTH_TIMEOUT_MS,
      `Piston ${node.nodeId}`,
      "/api/v2/runtimes",
    );
    if (!Array.isArray(payload)) {
      const detail = "The endpoint answered with JSON that is not a Piston runtime list.";
      console.error(`[piston-health] node=${node.nodeId} url=${finalUrl} unexpected JSON shape`);
      if (persist) await saveNodeHealth(node.nodeId, { status: "UNHEALTHY", error: detail });
      return { nodeId: node.nodeId, status: "UNHEALTHY", latencyMs: Date.now() - started, runtimes: 0, detail };
    }
    const latencyMs = Date.now() - started;
    console.info(
      `[piston-health] node=${node.nodeId} url=${finalUrl} status=200 contentType=application/json runtimes=${payload.length} ms=${latencyMs} -> ONLINE`,
    );
    if (persist) await saveNodeHealth(node.nodeId, { status: "ONLINE", error: "", resetFailures: true });
    return {
      nodeId: node.nodeId,
      status: "ONLINE",
      latencyMs,
      runtimes: payload.length,
      detail: `Piston answered with ${payload.length} runtimes in ${latencyMs}ms.`,
    };
  } catch (err) {
    const raw = err instanceof ExecutionServiceError ? err.detail : err instanceof Error ? err.message : "unknown";
    console.error(
      `[piston-health] node=${node.nodeId} configuredUrl=${node.url} finalUrl=${finalUrl} errorType=${
        err instanceof Error ? err.name : typeof err
      } detail=${raw.slice(0, 400)} ms=${Date.now() - started}`,
    );
    // Never blame Piston authentication for a hosting-side network refusal.
    const edgeBlocked = /error code: 100\d|direct ip|outbound network edge/i.test(raw);
    const detail = isEgressBlockedPort(node.url)
      ? `${describeEgressPortProblem(node.url)} (${raw})`
      : edgeBlocked || isDirectIpHost(node.url)
        ? `${describeDirectIpProblem(node.url)} (observed: ${raw})`
        : raw;
    if (persist) await saveNodeHealth(node.nodeId, { status: "OFFLINE", error: detail });
    return { nodeId: node.nodeId, status: "OFFLINE", latencyMs: Date.now() - started, runtimes: 0, detail };
  }
}


/** Healthy nodes are re-probed every 60s, unhealthy ones no more than every 120s. */
function isStale(node: PistonNode): boolean {
  if (!node.lastHealthCheck) return true;
  const age = Date.now() - new Date(node.lastHealthCheck).getTime();
  return node.healthStatus === "ONLINE" ? age > 60_000 : age > 120_000;
}

export async function checkAllNodes(force = false): Promise<NodeHealthResult[]> {
  const nodes = await listNodes();
  const out: NodeHealthResult[] = [];
  for (const node of nodes) {
    if (!force && !isStale(node)) continue;
    out.push(await checkNode(node));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Deterministic student → node assignment                             */
/* ------------------------------------------------------------------ */

/**
 * Server-side, stable and never derived from the browser: the student's
 * position in the registration order decides the batch,
 * `batchSize = ceil(totalStudents / activeNodes)`.
 */
async function computeAssignment(studentId: string, activeNodeIds: string[]): Promise<string> {
  if (activeNodeIds.length === 1) return activeNodeIds[0]!;
  let ordinal = -1;
  let total = activeNodeIds.length;
  try {
    const { ownDb } = await import("./own-db.server");
    const { data } = await ownDb().from("students").select("id").order("createdAt", { ascending: true });
    const ids = (data ?? []).map((row) => String((row as Record<string, unknown>)["id"]));
    if (ids.length) {
      total = ids.length;
      ordinal = ids.indexOf(studentId);
    }
  } catch (err) {
    console.error("[piston-pool] student ordering unavailable, falling back to a stable hash", err);
  }
  if (ordinal < 0) {
    // Stable fallback: a deterministic hash of the student's own id.
    let hash = 0;
    for (const char of studentId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return activeNodeIds[hash % activeNodeIds.length]!;
  }
  const batchSize = Math.max(1, Math.ceil(total / activeNodeIds.length));
  const index = Math.min(Math.floor(ordinal / batchSize), activeNodeIds.length - 1);
  return activeNodeIds[index]!;
}

/**
 * The sticky assignment for a student in a round. Once written it is reused for
 * every execution in that round, so adding a node later never moves a student
 * who is already competing.
 */
export async function assignedNodeFor(
  studentId: string,
  roundId: string,
  candidates: PistonNode[],
): Promise<string | null> {
  if (!candidates.length) return null;
  if (!studentId) return candidates[0]!.nodeId;
  const client = await schema();
  const key = roundId || "";
  const rows = await client.unsafe(
    "select node_id from codearena_private.piston_assignments where student_id = $1 and round_id = $2",
    [studentId, key],
  );
  const existing = rows[0] ? String(rows[0]["node_id"]) : "";
  if (existing && candidates.some((node) => node.nodeId === existing)) return existing;

  const chosen = await computeAssignment(
    studentId,
    candidates.map((node) => node.nodeId),
  );
  await client.unsafe(
    `insert into codearena_private.piston_assignments (student_id, round_id, node_id)
     values ($1,$2,$3)
     on conflict (student_id, round_id) do update set node_id = excluded.node_id`,
    [studentId, key, chosen],
  );
  return chosen;
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

const MAX_ATTEMPTS = 3;
const QUEUE_WAIT_MS = 15_000;
const QUEUE_POLL_MS = 300;

/** Nodes that may currently receive work: enabled and not known-offline. */
function usableNodes(nodes: PistonNode[]): PistonNode[] {
  return nodes.filter((node) => node.enabled && node.url.trim() && node.healthStatus !== "OFFLINE");
}

function orderFor(nodes: PistonNode[], assigned: string | null): PistonNode[] {
  const rest = nodes
    .filter((node) => node.nodeId !== assigned)
    .sort(
      (a, b) =>
        (a.healthStatus === "ONLINE" ? 0 : 1) - (b.healthStatus === "ONLINE" ? 0 : 1) ||
        a.currentLoad / a.maxConcurrentJobs - b.currentLoad / b.maxConcurrentJobs ||
        a.nodeId.localeCompare(b.nodeId),
    );
  const own = nodes.find((node) => node.nodeId === assigned);
  return own ? [own, ...rest] : rest;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type PoolResult = ExecResult & { nodeId: string; assignedNodeId: string; attempts: number };

/**
 * Runs one program on the pool.
 *
 * Returns `null` when the pool cannot serve the request at all (no nodes
 * configured / none usable) so the caller can continue with the existing
 * engine list and its Judge0 fallback. Participant errors (compile error,
 * runtime error, wrong output, TLE) are normal results and never fail over.
 */
export async function runOnPistonPool(input: ExecInput): Promise<PoolResult | null> {
  let nodes: PistonNode[];
  try {
    nodes = usableNodes(await listNodes());
  } catch (err) {
    console.error("[piston-pool] node pool unavailable", err);
    return null;
  }
  if (!nodes.length) return null;

  const studentId = String(input.studentId ?? "");
  const roundId = String(input.roundId ?? "");
  const assigned = await assignedNodeFor(studentId, roundId, nodes).catch(() => nodes[0]!.nodeId);
  const ordered = orderFor(nodes, assigned);

  let attempts = 0;
  let lastError: ExecutionServiceError | null = null;
  const deadline = Date.now() + QUEUE_WAIT_MS;

  for (const node of ordered) {
    if (attempts >= MAX_ATTEMPTS) break;

    // Bounded queue: wait for capacity on the assigned node before moving on,
    // never send work to a node at maxConcurrentJobs.
    let slot = await acquireSlot(node.nodeId);
    while (!slot && node.nodeId === assigned && Date.now() < deadline) {
      await sleep(QUEUE_POLL_MS);
      slot = await acquireSlot(node.nodeId);
    }
    if (!slot) continue;

    attempts += 1;
    const startedAt = new Date().toISOString();
    const started = Date.now();
    try {
      const result = await pistonAdapter.execute(
        {
          id: node.id,
          name: node.nodeId,
          provider: "PISTON",
          baseUrl: node.url,
          timeoutMs: node.timeoutMs,
        },
        input,
      );
      await noteSuccess(node.nodeId);
      await logExecution({
        submissionId: input.submissionId ?? null,
        studentId: studentId || null,
        roundId: roundId || null,
        assignedNodeId: assigned ?? "",
        actualNodeId: node.nodeId,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        retryCount: attempts - 1,
        status: result.status ?? "ACCEPTED",
        failureReason: "",
      });
      return { ...result, nodeId: node.nodeId, assignedNodeId: assigned ?? node.nodeId, attempts };
    } catch (err) {
      const error =
        err instanceof ExecutionServiceError
          ? err
          : new ExecutionServiceError(
              "Code execution is temporarily unavailable. Please try again.",
              err instanceof Error ? err.message : "unknown execution failure",
            );
      lastError = error;
      // The language is not installed on the pool: retrying elsewhere cannot
      // help and the node is not at fault.
      if (error instanceof LanguageUnavailableError) throw error;
      console.error(`[piston-pool] ${node.nodeId} failed: ${error.detail}`);
      await noteFailure(node.nodeId, error.detail);
      await logExecution({
        submissionId: input.submissionId ?? null,
        studentId: studentId || null,
        roundId: roundId || null,
        assignedNodeId: assigned ?? "",
        actualNodeId: node.nodeId,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        retryCount: attempts - 1,
        status: "FAILED",
        failureReason: error.detail,
      });
      // A timed-out run may still be executing on that VM: retrying elsewhere
      // could double-execute, so stop and let the caller decide.
      if (error.uncertain) throw error;
    } finally {
      await releaseSlot(node.nodeId);
    }
  }

  if (lastError) throw lastError;
  return null;
}
