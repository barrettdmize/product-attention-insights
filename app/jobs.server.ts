/**
 * Lightweight async job pattern for AI insight generation.
 * Enqueues jobs; worker processes them with retries and backoff.
 */

import prisma from "./db.server";
import { generateProductInsightExplanation } from "./ai-insight.server";

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [2000, 5000, 10000]; // 2s, 5s, 10s

export type InsightJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";

/** Enqueue a single AI insight job. Returns job id or null if already queued/running (unless force=true for regenerate). */
export async function enqueueInsightJob(
  shop: string,
  productId: string,
  runId?: string,
  force = false
): Promise<string | null> {
  const existing = await prisma.insightJob.findFirst({
    where: { shop, productId, status: { in: ["QUEUED", "RUNNING"] } },
  });
  if (existing && !force) return null;
  if (existing && force) {
    await prisma.insightJob.update({
      where: { id: existing.id },
      data: { status: "FAILED", lastError: "Superseded by regenerate" },
    });
  }

  const job = await prisma.insightJob.create({
    data: { shop, productId, runId, status: "QUEUED" },
  });

  const insight = await prisma.productInsight.findUnique({
    where: { shop_productId: { shop, productId } },
  });
  if (insight) {
    await prisma.productInsight.update({
      where: { id: insight.id },
      data: { aiStatus: "QUEUED", aiError: null },
    });
  }

  return job.id;
}

/** Enqueue jobs for multiple products. Returns count of newly enqueued. */
export async function enqueueBatch(
  shop: string,
  productIds: string[],
  runId: string
): Promise<number> {
  let enqueued = 0;
  for (const productId of productIds) {
    const id = await enqueueInsightJob(shop, productId, runId);
    if (id) enqueued++;
  }
  return enqueued;
}

/** Claim a QUEUED job for processing (respects nextRetryAt). Returns job + insight or null. Concurrency-safe. */
export async function claimNextJob(): Promise<{
  job: { id: string; shop: string; productId: string; runId: string | null };
  insight: {
    id: string;
    productTitle: string;
    status: string;
    recommendation: string;
    lastProductUpdatedAt: Date;
  };
} | null> {
  const now = new Date();
  const job = await prisma.$transaction(async (tx) => {
    const candidate = await tx.insightJob.findFirst({
      where: {
        status: "QUEUED",
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
      },
      orderBy: { createdAt: "asc" },
    });
    if (!candidate) return null;

    const updated = await tx.insightJob.updateMany({
      where: {
        id: candidate.id,
        status: "QUEUED",
        updatedAt: candidate.updatedAt,
      },
      data: {
        status: "RUNNING",
        attempts: { increment: 1 },
        nextRetryAt: null,
        updatedAt: new Date(),
      },
    });
    if (updated.count === 0) return null; // Another worker claimed it
    return { ...candidate, attempts: candidate.attempts + 1 };
  });

  if (!job) return null;

  const insight = await prisma.productInsight.findUnique({
    where: { shop_productId: { shop: job.shop, productId: job.productId } },
  });
  if (!insight) {
    await prisma.insightJob.update({
      where: { id: job.id },
      data: { status: "FAILED", lastError: "ProductInsight not found" },
    });
    return null;
  }

  await prisma.productInsight.update({
    where: { id: insight.id },
    data: { aiStatus: "RUNNING", aiError: null },
  });

  return {
    job: { id: job.id, shop: job.shop, productId: job.productId, runId: job.runId },
    insight: {
      id: insight.id,
      productTitle: insight.productTitle,
      status: insight.status,
      recommendation: insight.recommendation,
      lastProductUpdatedAt: insight.lastProductUpdatedAt,
      productStatus: insight.productStatus,
      hasFeaturedImage: insight.hasFeaturedImage,
      inventoryStatus: insight.inventoryStatus,
      inventoryAvailable: insight.inventoryAvailable,
    },
  };
}

/** Process a claimed job: call OpenAI, update ProductInsight and InsightJob. */
export async function processJob(
  jobId: string,
  insight: {
    id: string;
    productTitle: string;
    status: string;
    recommendation: string;
    lastProductUpdatedAt: Date;
    productStatus: string | null;
    hasFeaturedImage: boolean | null;
    inventoryStatus: string | null;
    inventoryAvailable: number | null;
  },
  shop: string,
  productId: string,
  runId: string | null
): Promise<void> {
  try {
    const { output, model } = await generateProductInsightExplanation({
      productTitle: insight.productTitle,
      vendor: null,
      productType: null,
      daysSinceUpdated: Math.floor(
        (Date.now() - insight.lastProductUpdatedAt.getTime()) / (1000 * 60 * 60 * 24)
      ),
      status: insight.status,
      recommendation: insight.recommendation,
      updatedAt: insight.lastProductUpdatedAt.toISOString(),
      productStatus: insight.productStatus ?? undefined,
      hasFeaturedImage: insight.hasFeaturedImage ?? undefined,
      inventoryStatus: insight.inventoryStatus ?? undefined,
      inventoryAvailable: insight.inventoryAvailable ?? undefined,
    });

    const nextStepsJson =
      output.nextSteps.length > 0 ? JSON.stringify(output.nextSteps) : null;

    await prisma.$transaction([
      prisma.productInsight.update({
        where: { id: insight.id },
        data: {
          aiExplanation: [output.summary, output.caveats].filter(Boolean).join(" "),
          aiActionType: output.actionType,
          aiGeneratedAt: new Date(),
          aiModel: model,
          aiStatus: "SUCCEEDED",
          aiError: null,
          reasonsJson: nextStepsJson,
        },
      }),
      prisma.insightJob.update({
        where: { id: jobId },
        data: { status: "SUCCEEDED", lastError: null },
      }),
    ]);

    if (runId) {
      await prisma.run.update({
        where: { id: runId },
        data: { succeeded: { increment: 1 } },
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI generation failed.";
    const job = await prisma.insightJob.findUnique({ where: { id: jobId } });
    const attempts = job?.attempts ?? 1;
    const willRetry = attempts < MAX_ATTEMPTS;
    const backoffMs = getBackoffMs(attempts - 1);
    const nextRetryAt = willRetry ? new Date(Date.now() + backoffMs) : null;

    await prisma.$transaction([
      prisma.productInsight.update({
        where: { id: insight.id },
        data: {
          aiStatus: willRetry ? "QUEUED" : "FAILED",
          aiError: willRetry ? null : message.slice(0, 500),
        },
      }),
      prisma.insightJob.update({
        where: { id: jobId },
        data: {
          status: willRetry ? "QUEUED" : "FAILED",
          lastError: message.slice(0, 500),
          nextRetryAt,
        },
      }),
    ]);

    if (runId) {
      if (attempts >= MAX_ATTEMPTS) {
        await prisma.run.update({
          where: { id: runId },
          data: { failed: { increment: 1 } },
        });
      }
    }
  }
}

/** Get backoff delay in ms for attempt index (0-based). */
export function getBackoffMs(attemptIndex: number): number {
  return BACKOFF_MS[Math.min(attemptIndex, BACKOFF_MS.length - 1)] ?? 10000;
}
