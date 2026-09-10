import Fastify, { type FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { configSchema } from "../config/schema.js";
import { regenerate, ConcurrentRegenerationError } from "../pipeline.js";
import type { Repository } from "../state/repository.js";
import type { ConfigHolder } from "../config/holder.js";
import type { Logger } from "../logging/logger.js";
import type { OverrideAction } from "../types.js";

export interface ServerDeps {
  repo: Repository;
  configHolder: ConfigHolder;
  domain: string;
  logger: Logger;
  feedToken: string;
  adminToken: string;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const { repo, configHolder, domain, logger, feedToken, adminToken } = deps;

  // --- public feed ---

  app.get("/health", async () => ({ status: "ok" }));

  app.get<{ Querystring: { token?: string } }>("/feeds/study.ics", async (req, reply) => {
    return serveCachedIcs(reply, req.headers["if-none-match"], req.query.token, {
      token: feedToken,
      icsKey: "last_good_ics",
      generatedAtKey: "last_good_ics_generated_at",
    });
  });

  app.get<{ Querystring: { token?: string } }>("/feeds/school.ics", async (req, reply) => {
    return serveCachedIcs(reply, req.headers["if-none-match"], req.query.token, {
      token: feedToken,
      icsKey: "last_good_school_ics",
      generatedAtKey: "last_good_school_ics_generated_at",
    });
  });

  function serveCachedIcs(
    reply: any,
    ifNoneMatch: string | string[] | undefined,
    providedToken: string | undefined,
    opts: { token: string; icsKey: string; generatedAtKey: string }
  ) {
    if (providedToken !== opts.token) {
      return reply.code(403).send({ error: "invalid or missing token" });
    }
    const ics = repo.getKv(opts.icsKey);
    if (!ics) {
      return reply.code(503).send({ error: "No calendar has been generated yet" });
    }
    const etag = `"${createHash("sha256").update(ics).digest("hex").slice(0, 32)}"`;
    const generatedAt = repo.getKv(opts.generatedAtKey) ?? new Date().toISOString();

    if (ifNoneMatch === etag) {
      return reply.code(304).send();
    }

    reply.header("Content-Type", "text/calendar; charset=utf-8");
    reply.header("ETag", etag);
    reply.header("Last-Modified", new Date(generatedAt).toUTCString());
    reply.header("Cache-Control", "no-cache");
    return reply.send(ics);
  }

  // --- admin auth guard ---
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/admin/")) return;
    const auth = req.headers["authorization"];
    const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
    if (token !== adminToken) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.post("/admin/regenerate", async (_req, reply) => {
    try {
      const run = await regenerate({ repo, configHolder, domain, logger }, "manual");
      if (run.status === "FAILED") {
        return reply.code(502).send(run);
      }
      return reply.send(run);
    } catch (err) {
      if (err instanceof ConcurrentRegenerationError) {
        return reply.code(409).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get("/admin/sessions", async () => repo.getAllStudySessions());

  app.get<{ Params: { id: string } }>("/admin/sessions/:id", async (req, reply) => {
    const session = repo.getStudySession(req.params.id);
    if (!session) return reply.code(404).send({ error: "not found" });
    return session;
  });

  async function applyOverrideAndRegenerate(
    reply: any,
    sessionId: string,
    action: OverrideAction,
    newStartUtc: string | null = null,
    newEndUtc: string | null = null
  ) {
    const session = repo.getStudySession(sessionId);
    if (!session) return reply.code(404).send({ error: "not found" });

    repo.insertOverride({
      id: randomUUID(),
      studySessionId: sessionId,
      action,
      newStartUtc,
      newEndUtc,
      createdAt: new Date().toISOString(),
    });

    try {
      await regenerate({ repo, configHolder, domain, logger }, "manual");
    } catch (err) {
      if (!(err instanceof ConcurrentRegenerationError)) throw err;
      // Another regeneration was already running; the override is saved and
      // will be picked up by that run or the next one.
    }
    return repo.getStudySession(sessionId);
  }

  app.post<{ Params: { id: string } }>("/admin/sessions/:id/lock", async (req, reply) => {
    return applyOverrideAndRegenerate(reply, req.params.id, "LOCK");
  });

  app.post<{ Params: { id: string } }>("/admin/sessions/:id/skip", async (req, reply) => {
    return applyOverrideAndRegenerate(reply, req.params.id, "SKIP");
  });

  app.post<{ Params: { id: string } }>("/admin/sessions/:id/unlock", async (req, reply) => {
    return applyOverrideAndRegenerate(reply, req.params.id, "UNLOCK");
  });

  // Not explicitly listed in the route spec, but RESCHEDULE is a required
  // override type with no other way to invoke it — see README assumptions.
  app.post<{ Params: { id: string }; Body: { startUtc: string; endUtc: string } }>(
    "/admin/sessions/:id/reschedule",
    async (req, reply) => {
      const { startUtc, endUtc } = req.body ?? ({} as any);
      if (!startUtc || !endUtc) {
        return reply.code(400).send({ error: "startUtc and endUtc are required" });
      }
      return applyOverrideAndRegenerate(reply, req.params.id, "RESCHEDULE", startUtc, endUtc);
    }
  );

  app.get("/admin/runs", async (req) => {
    const q = req.query as { limit?: string };
    const limit = q.limit ? Math.min(200, Math.max(1, parseInt(q.limit, 10))) : 50;
    return repo.listRuns(limit);
  });

  app.get<{ Params: { id: string } }>("/admin/runs/:id", async (req, reply) => {
    const run = repo.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: "not found" });
    return run;
  });

  app.get("/admin/config", async () => configHolder.get());

  app.put("/admin/config", async (req, reply) => {
    const parsed = configSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid config",
        issues: parsed.error.issues,
      });
    }
    const updated = configHolder.set(parsed.data);
    try {
      await regenerate({ repo, configHolder, domain, logger }, "manual");
    } catch (err) {
      if (!(err instanceof ConcurrentRegenerationError)) throw err;
    }
    return updated;
  });

  return app;
}
