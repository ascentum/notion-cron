import express, { NextFunction, Request, Response } from "express";
import { verifyDiscordSignature } from "../lib/discord";
import { config } from "./config";
import { closeDatabase, initializeDatabase, listJobRuns } from "./database";
import { handleDiscordInteraction } from "./discord-handler";
import { startScheduler } from "./scheduler";
import { sendDailySnippets } from "./services/daily-snippet-service";
import { retryFailedDispatch, sweepDueDispatches } from "./services/dispatch-service";
import { runWeeklyReport } from "./services/weekly-report-service";

function requireInternalToken(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.header("authorization");
  if (authHeader !== `Bearer ${config.internalAdminToken}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

function normalizePerson(input: unknown) {
  return input === "youngmin" || input === "seyeon" ? input : null;
}

async function main() {
  initializeDatabase();

  const app = express();
  const scheduler = config.enableScheduler
    ? startScheduler()
    : { stop() {} };

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      service: "notion-cron",
      schedulerEnabled: config.enableScheduler,
      schedulerTickSeconds: config.schedulerTickSeconds,
      recentJobs: listJobRuns(10),
    });
  });

  app.post(
    "/discord-interact",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (req, res) => {
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body.toString("utf8")
        : String(req.body ?? "");
      const signature = req.header("x-signature-ed25519") ?? "";
      const timestamp = req.header("x-signature-timestamp") ?? "";

      if (!verifyDiscordSignature(signature, timestamp, rawBody)) {
        res.status(401).send("Unauthorized");
        return;
      }

      try {
        const response = await handleDiscordInteraction(rawBody);
        res.status(response.status).json(response.body);
      } catch (error) {
        console.error("[discord-interact] failed:", error);
        res.status(500).json({
          type: 4,
          data: { content: `❌ 처리 중 오류가 발생했어요: ${String(error)}`, flags: 64 },
        });
      }
    }
  );

  app.use(express.json());
  app.use("/internal", requireInternalToken);

  app.post("/internal/snippets/send-daily", async (req, res) => {
    try {
      const person = normalizePerson(req.body?.person);
      const force = req.body?.force === true;
      const result = await sendDailySnippets(new Date(), {
        targetPerson: person,
        force,
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.post("/internal/snippets/sweep-timeouts", async (_req, res) => {
    try {
      const result = await sweepDueDispatches(new Date());
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.post("/internal/reports/run-weekly", async (_req, res) => {
    try {
      const result = await runWeeklyReport(new Date());
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.post("/internal/snippets/retry/:id", async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (Number.isNaN(id)) {
        res.status(400).json({ error: "Invalid dispatch id" });
        return;
      }

      const result = await retryFailedDispatch(id);
      if (!result.ok) {
        res.status(result.alreadyProcessed ? 409 : 500).json(result);
        return;
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  const server = app.listen(config.port, () => {
    console.log(`[server] listening on port ${config.port}`);
    if (!config.enableScheduler) {
      console.log("[server] scheduler disabled");
    }
  });

  const shutdown = () => {
    scheduler.stop();
    server.close(() => {
      closeDatabase();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[server] startup failed:", error);
  process.exit(1);
});
