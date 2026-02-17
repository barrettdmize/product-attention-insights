#!/usr/bin/env node
/**
 * Lightweight worker for AI insight jobs.
 * Polls for QUEUED jobs, processes them with retries and backoff.
 * Run: npm run worker
 */

import path from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../.env") });
import { claimNextJob, processJob } from "../app/jobs.server";
import prisma from "../app/db.server";

const POLL_INTERVAL_MS = 2000;

async function tick(): Promise<boolean> {
  const claimed = await claimNextJob();
  if (!claimed) return false;

  const { job, insight } = claimed;
  await processJob(
    job.id,
    insight,
    job.shop,
    job.productId,
    job.runId
  );

  return true;
}

async function updateRunCompletion(): Promise<void> {
  const runs = await prisma.run.findMany({
    where: { status: "RUNNING" },
    include: { _count: { select: { jobs: true } } },
  });

  for (const run of runs) {
    const pending = await prisma.insightJob.count({
      where: { runId: run.id, status: { in: ["QUEUED", "RUNNING"] } },
    });
    if (pending === 0) {
      await prisma.run.update({
        where: { id: run.id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
        },
      });
    }
  }
}

async function main(): Promise<void> {
  console.log("[worker] Starting AI insight job worker...");
  if (!process.env.OPENAI_API_KEY) {
    console.warn("[worker] OPENAI_API_KEY not set. Jobs will fail until it is set.");
  }

  let consecutiveEmpty = 0;
  while (true) {
    try {
      const didWork = await tick();
      if (didWork) {
        consecutiveEmpty = 0;
      } else {
        consecutiveEmpty++;
        if (consecutiveEmpty % 5 === 0 && consecutiveEmpty > 0) {
          await updateRunCompletion();
        }
      }
    } catch (err) {
      console.error("[worker] Error:", err);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error("[worker] Fatal:", err);
  process.exit(1);
});
