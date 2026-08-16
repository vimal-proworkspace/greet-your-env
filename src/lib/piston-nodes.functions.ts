/**
 * Admin server functions for the Piston node pool (Admin → Execution
 * infrastructure). Every handler re-verifies the ADMIN role server-side, and
 * nothing here ever returns infrastructure secrets — only the node address,
 * health, capacity and counters that an administrator needs.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const nodeInput = z.object({
  id: z.string().uuid().optional(),
  nodeId: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-_]*$/i, "Use letters, digits, hyphen or underscore."),
  url: z.string().trim().min(4).max(300),
  enabled: z.boolean(),
  maxConcurrentJobs: z.number().int().min(1).max(200),
  timeoutMs: z.number().int().min(2000).max(60000).optional(),
});

export type PistonNodeFormInput = z.infer<typeof nodeInput>;

/** Node pool + recent execution log for the admin infrastructure screen. */
export const listPistonNodes = createServerFn({ method: "POST" }).handler(async () => {
  const { requireAdmin } = await import("./app-session.server");
  await requireAdmin();
  const pool = await import("./piston-pool.server");

  // Opportunistic health refresh: only nodes whose last check is stale are
  // probed, so an unhealthy VM is never hammered.
  await pool.checkAllNodes().catch((err) => {
    console.error("[piston-admin] background health check failed", err);
    return [];
  });

  const [nodes, executions] = await Promise.all([
    pool.listNodes(),
    pool.readExecutionLogs(40).catch(() => []),
  ]);
  return { nodes, executions, checkedAt: new Date().toISOString() };
});

export const savePistonNode = createServerFn({ method: "POST" })
  .inputValidator((input: PistonNodeFormInput) => nodeInput.parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    await requireAdmin();
    const pool = await import("./piston-pool.server");

    const validated = pool.validateNodeUrl(data.url);
    if (validated.error) throw new Error(validated.error);

    const existing = await pool.listNodes();
    const previous = data.id ? existing.find((node) => node.id === data.id) ?? null : null;
    if (data.id && !previous) throw new Error("That Piston node no longer exists.");
    const clash = existing.find((node) => node.nodeId === data.nodeId && node.id !== data.id);
    if (clash) throw new Error(`Node ID "${data.nodeId}" is already used.`);

    const payload = {
      nodeId: data.nodeId,
      url: validated.url,
      enabled: data.enabled,
      maxConcurrentJobs: data.maxConcurrentJobs,
      ...(data.timeoutMs !== undefined ? { timeoutMs: data.timeoutMs } : {}),
    };

    // Server-side health check before the node may serve student code.
    const probe = await pool.checkNode(
      {
        ...(previous ?? {
          id: "",
          healthStatus: "OFFLINE" as const,
          lastHealthCheck: null,
          lastError: "",
          failureCount: 0,
          currentLoad: 0,
          totalExecutions: 0,
          totalFailures: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        nodeId: payload.nodeId,
        url: payload.url,
        enabled: payload.enabled,
        maxConcurrentJobs: payload.maxConcurrentJobs,
        timeoutMs: payload.timeoutMs ?? previous?.timeoutMs ?? 20_000,
      },
      false,
    );
    if (payload.enabled && probe.status !== "ONLINE") {
      throw new Error(`That address did not answer as a Piston API: ${probe.detail}`);
    }

    const saved = previous
      ? await pool.updateNode(previous.id, payload)
      : await pool.createNode(payload);
    if (!saved) throw new Error("Could not save that Piston node.");

    // Persist the freshly observed health for the saved record.
    await pool.checkNode(saved).catch(() => null);
    return { ok: true, nodeId: saved.nodeId, detail: probe.detail };
  });

export const checkPistonNode = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    await requireAdmin();
    const pool = await import("./piston-pool.server");
    const node = await pool.getNode(data.id);
    if (!node) throw new Error("That Piston node no longer exists.");
    return pool.checkNode(node);
  });

export const setPistonNodeEnabled = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string; enabled: boolean }) =>
    z.object({ id: z.string().uuid(), enabled: z.boolean() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    await requireAdmin();
    const pool = await import("./piston-pool.server");
    const updated = await pool.updateNode(data.id, { enabled: data.enabled });
    if (!updated) throw new Error("That Piston node no longer exists.");
    if (data.enabled) await pool.checkNode(updated).catch(() => null);
    return { ok: true };
  });

export const deletePistonNode = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    await requireAdmin();
    const pool = await import("./piston-pool.server");
    // Historical execution records are intentionally kept: they retain the
    // actualNodeId that ran each submission.
    const removed = await pool.deleteNode(data.id);
    if (!removed) throw new Error("That Piston node no longer exists.");
    const remaining = (await pool.listNodes()).filter(
      (node) => node.enabled && node.healthStatus !== "OFFLINE",
    );
    return { ok: true, remainingUsable: remaining.length };
  });
