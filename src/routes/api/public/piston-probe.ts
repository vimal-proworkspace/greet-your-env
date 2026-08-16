import { createFileRoute } from "@tanstack/react-router";

/**
 * Read-only outbound-connectivity diagnostic for the configured Piston nodes.
 *
 * It never accepts a URL from the caller (no SSRF surface): it probes only the
 * node addresses an administrator already saved, and returns the node id, the
 * HTTP status the *backend* observed and a short reason. No credentials, no
 * connection strings and no student data are exposed.
 */
export const Route = createFileRoute("/api/public/piston-probe")({
  server: {
    handlers: {
      GET: async () => {
        const out: Array<Record<string, unknown>> = [];
        try {
          const pool = await import("@/lib/piston-pool.server");
          const nodes = await pool.listNodes();
          for (const node of nodes) {
            const started = Date.now();
            let port = "";
            try {
              const u = new URL(node.url);
              port = u.port || (u.protocol === "https:" ? "443" : "80");
            } catch {
              port = "?";
            }
            try {
              const res = await fetch(`${node.url}/api/v2/runtimes`, {
                method: "GET",
                headers: { accept: "application/json" },
              });
              const body = (await res.text()).slice(0, 200).replace(/\s+/g, " ").trim();
              out.push({
                nodeId: node.nodeId,
                port,
                status: res.status,
                contentType: res.headers.get("content-type") ?? "unknown",
                cfRay: res.headers.has("cf-ray"),
                bodyStart: body,
                ms: Date.now() - started,
              });
            } catch (err) {
              out.push({
                nodeId: node.nodeId,
                port,
                error: err instanceof Error ? `${err.name}: ${err.message}` : "unknown",
                ms: Date.now() - started,
              });
            }
          }
        } catch (err) {
          out.push({ fatal: err instanceof Error ? err.message : "unknown" });
        }
        return new Response(JSON.stringify({ probes: out }, null, 2), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
