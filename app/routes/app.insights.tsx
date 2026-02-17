import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher, Link } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Box,
  InlineGrid,
  Badge,
  Tooltip,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import type { ProductInsightStatus } from "@prisma/client";
import { enqueueInsightJob, enqueueBatch } from "../jobs.server";
import {
  computeInventoryStatus,
  computeConfidence,
  getConfidenceLabel,
  buildConfidenceExplanation,
  type MissingSignal,
  type InventoryStatus,
} from "../insights/signals.server";

const PRODUCTS_FIRST = 25;
const BATCH_MAX = 10;

/** Naive attention score: days since product was last updated. Higher = more neglected. */
function getDaysSinceUpdated(updatedAt: string | Date): number {
  const updated =
    typeof updatedAt === "string"
      ? new Date(updatedAt).getTime()
      : updatedAt.getTime();
  const now = Date.now();
  return Math.floor((now - updated) / (1000 * 60 * 60 * 24));
}

function getStatusAndRecommendation(
  daysSinceUpdated: number,
  inventoryStatus: InventoryStatus
): { status: ProductInsightStatus; recommendation: string } {
  if (inventoryStatus === "OUT_OF_STOCK") {
    return {
      status: "NEGLECTED",
      recommendation:
        "Out of stock. Restock or update availability to keep the product visible.",
    };
  }
  if (inventoryStatus === "LOW") {
    return {
      status: "NEGLECTED",
      recommendation:
        "Low inventory. Review replenishment or consider pausing ads until restocked.",
    };
  }
  if (daysSinceUpdated <= 7) {
    return {
      status: "RECENTLY_UPDATED",
      recommendation: "Recently updated — no action needed.",
    };
  }
  if (daysSinceUpdated <= 60) {
    return {
      status: "HEALTHY",
      recommendation: "Consider a quick review in the next few weeks.",
    };
  }
  return {
    status: "NEGLECTED",
    recommendation:
      "Update description, images, or pricing to re-engage customers.",
  };
}

/** Extract total inventory from product node. Fallback: sum variant quantities (capped at 10 variants). */
function getTotalInventory(node: Record<string, unknown>): number | null {
  if (typeof node.totalInventory === "number") return node.totalInventory;
  const variants = node.variants as { nodes?: Array<{ inventoryQuantity?: number }> } | undefined;
  if (!variants?.nodes?.length) return null;
  let total = 0;
  for (const v of variants.nodes.slice(0, 10)) {
    if (typeof v.inventoryQuantity === "number") total += v.inventoryQuantity;
  }
  return total;
}

const PRODUCTS_QUERY_FULL = `#graphql
  query GetProductsForInsights($first: Int!) {
    products(first: $first, sortKey: UPDATED_AT, reverse: false) {
      nodes {
        id
        title
        updatedAt
        status
            featuredMedia { id }
            featuredImage { id }
        totalInventory
        tracksInventory
        variants(first: 10) {
          nodes {
            inventoryQuantity
          }
        }
      }
    }
  }
`;

const PRODUCTS_QUERY_MINIMAL = `#graphql
  query GetProductsForInsightsMinimal($first: Int!) {
    products(first: $first, sortKey: UPDATED_AT, reverse: false) {
      nodes {
        id
        title
        updatedAt
      }
    }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  let response = await admin.graphql(PRODUCTS_QUERY_FULL, {
    variables: { first: PRODUCTS_FIRST },
  });
  let json = await response.json();

  if (json?.errors?.length) {
    response = await admin.graphql(PRODUCTS_QUERY_MINIMAL, {
      variables: { first: PRODUCTS_FIRST },
    });
    json = await response.json();
  }

  const nodes = (json?.data?.products?.nodes ?? []) as Record<string, unknown>[];

  for (const node of nodes) {
    const daysSinceUpdated = getDaysSinceUpdated(node.updatedAt as string);
    const hasStatus = node.status != null;
    const hasImage =
      (node.featuredMedia != null && (node.featuredMedia as { id?: string })?.id != null) ||
      (node.featuredImage != null && (node.featuredImage as { id?: string })?.id != null);
    const totalAvailable = getTotalInventory(node);
    const hasInventory =
      node.tracksInventory === true
        ? totalAvailable !== null
        : node.tracksInventory === false
          ? true
          : totalAvailable !== null;
    const inventoryStatus = computeInventoryStatus(totalAvailable);
    const { status, recommendation } = getStatusAndRecommendation(
      daysSinceUpdated,
      inventoryStatus
    );

    const missingSignals: MissingSignal[] = [];
    if (!hasStatus) missingSignals.push("status");
    if (!hasImage) missingSignals.push("image");
    if (!hasInventory) missingSignals.push("inventory");

    const confidenceScore = computeConfidence({
      hasStatus,
      hasImage,
      hasInventory,
      daysSinceUpdated,
    });
    const confidenceLabel = getConfidenceLabel(confidenceScore);
    const confidenceExplanation =
      confidenceLabel === "Low"
        ? buildConfidenceExplanation(missingSignals)
        : null;

    const productStatus =
      typeof node.status === "string" ? node.status : null;

    await prisma.productInsight.upsert({
      where: {
        shop_productId: { shop, productId: node.id as string },
      },
      create: {
        shop,
        productId: node.id as string,
        productTitle: (node.title as string) ?? "Untitled",
        attentionScore: daysSinceUpdated,
        status,
        recommendation,
        lastProductUpdatedAt: new Date(node.updatedAt as string),
        productStatus,
        hasFeaturedImage: hasImage,
        inventoryStatus,
        inventoryAvailable: totalAvailable ?? undefined,
        aiConfidence: confidenceLabel,
        confidenceExplanation,
      },
      update: {
        productTitle: (node.title as string) ?? "Untitled",
        attentionScore: daysSinceUpdated,
        status,
        recommendation,
        lastProductUpdatedAt: new Date(node.updatedAt as string),
        lastEvaluatedAt: new Date(),
        productStatus,
        hasFeaturedImage: hasImage,
        inventoryStatus,
        inventoryAvailable: totalAvailable ?? undefined,
        aiConfidence: confidenceLabel,
        confidenceExplanation,
      },
    });
  }

  const insights = await prisma.productInsight.findMany({
    where: { shop },
    orderBy: { attentionScore: "desc" },
  });

  return { insights };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent"); // "generate" | "regenerate" | "batch"

  if (intent === "batch") {
    const productIdsRaw = formData.get("productIds");
    const productIds = typeof productIdsRaw === "string"
      ? productIdsRaw.split(",").filter(Boolean).slice(0, BATCH_MAX)
      : [];
    if (productIds.length === 0) {
      return { ok: false, error: "No products selected for batch." };
    }

    const run = await prisma.run.create({
      data: {
        shop,
        status: "RUNNING",
        productsQueued: productIds.length,
      },
    });

    const enqueued = await enqueueBatch(shop, productIds, run.id);
    return { ok: true, runId: run.id, enqueued };
  }

  const productId = formData.get("productId");
  if (
    !productId ||
    typeof productId !== "string" ||
    (intent !== "generate" && intent !== "regenerate")
  ) {
    return { ok: false, error: "Missing productId or intent." };
  }

  const insight = await prisma.productInsight.findUnique({
    where: { shop_productId: { shop, productId } },
  });

  if (!insight) {
    return { ok: false, error: "Product insight not found." };
  }

  const force = intent === "regenerate";
  const jobId = await enqueueInsightJob(shop, productId, undefined, force);
  if (!jobId) {
    return { ok: false, error: "Job already queued or running." };
  }

  return { ok: true, productId, jobId };
};

function getJobStatusLabel(aiStatus: string | null): string {
  switch (aiStatus) {
    case "QUEUED":
      return "Queued";
    case "RUNNING":
      return "Generating…";
    case "SUCCEEDED":
      return "Succeeded";
    case "FAILED":
      return "Failed";
    default:
      return "";
  }
}

function getConfidenceTooltip(confidence: string | null): string {
  switch (confidence) {
    case "High":
      return "High confidence: Insight generated from complete product signals (inventory, status, and update history).";
    case "Medium":
      return "Medium confidence: Some product signals may be missing; review before acting.";
    case "Low":
      return "Low confidence: Limited product data available; verify details manually.";
    default:
      return "";
  }
}

function getConfidenceBadgeTone(
  label: string | null
): "success" | "attention" | "critical" | "info" | undefined {
  if (label === "High") return "success";
  if (label === "Medium") return "attention";
  if (label === "Low") return "critical";
  return undefined;
}

export default function InsightsPage() {
  const { insights } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const batchFetcher = useFetcher<typeof action>();

  const isGenerating = fetcher.state !== "idle";
  const generatingProductId =
    isGenerating && fetcher.formData?.get("productId")?.toString();
  const isBatchRunning = batchFetcher.state !== "idle";

  const visibleProductIds = insights.slice(0, BATCH_MAX).map((i) => i.productId);

  return (
    <Page title="Product Attention Insights">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner tone="info">
              AI insight is advisory only; it won’t change product data.
            </Banner>

            {insights.length > 0 && (
              <InlineStack gap="200" blockAlign="center">
                <batchFetcher.Form method="post">
                  <input
                    type="hidden"
                    name="intent"
                    value="batch"
                  />
                  <input
                    type="hidden"
                    name="productIds"
                    value={visibleProductIds.join(",")}
                  />
                  <Button
                    variant="secondary"
                    size="slim"
                    submit
                    loading={isBatchRunning}
                    disabled={isBatchRunning}
                  >
                    Generate AI for visible list (up to {BATCH_MAX})
                  </Button>
                </batchFetcher.Form>
                {batchFetcher.data?.ok && batchFetcher.data?.runId && (
                  <Text as="span" tone="success">
                    Enqueued {batchFetcher.data.enqueued} jobs.{" "}
                    <Link to={`/app/runs/${batchFetcher.data.runId}`}>View run</Link>
                  </Text>
                )}
              </InlineStack>
            )}

            {insights.length === 0 ? (
              <Card>
                <Text as="p">
                  No product insights yet. Add products in your store and
                  refresh.
                </Text>
              </Card>
            ) : (
              <BlockStack gap="400">
                {insights.map((insight) => {
                  const isThisGenerating =
                    generatingProductId === insight.productId;
                  const isBusy =
                    insight.aiStatus === "RUNNING" ||
                    insight.aiStatus === "QUEUED" ||
                    isThisGenerating;

                  return (
                    <Card key={insight.id} padding="400">
                      <BlockStack gap="300">
                        <InlineGrid columns={2} gap="300">
                          <BlockStack gap="100">
                            <InlineStack gap="200" blockAlign="center" wrap={false}>
                              <Text as="h3" fontWeight="semibold">
                                {insight.productTitle}
                              </Text>
                              {insight.aiConfidence && (() => {
                                const tooltipContent = getConfidenceTooltip(insight.aiConfidence);
                                const badge = (
                                  <Badge tone={getConfidenceBadgeTone(insight.aiConfidence)}>
                                    {insight.aiConfidence}
                                  </Badge>
                                );
                                return tooltipContent ? (
                                  <Tooltip content={tooltipContent}>{badge}</Tooltip>
                                ) : (
                                  badge
                                );
                              })()}
                            </InlineStack>
                            {insight.aiConfidence === "Low" &&
                              insight.confidenceExplanation && (
                                <Text as="p" tone="subdued" variant="bodySm">
                                  {insight.confidenceExplanation}
                                </Text>
                              )}
                            <InlineStack gap="200" blockAlign="center">
                              <Text as="span" tone="subdued">
                                {insight.attentionScore} days since updated
                              </Text>
                              <Text as="span" tone="subdued">
                                •
                              </Text>
                              <Text as="span" tone="subdued">
                                {insight.status
                                  .replace(/_/g, " ")
                                  .toLowerCase()}
                              </Text>
                              {(insight.aiStatus === "QUEUED" ||
                                insight.aiStatus === "RUNNING") && (
                                <Text as="span" tone="subdued">
                                  • {getJobStatusLabel(insight.aiStatus)}
                                </Text>
                              )}
                            </InlineStack>
                            <Text as="p" tone="subdued">
                              {insight.recommendation}
                            </Text>
                          </BlockStack>
                          <Box paddingBlockStart="100">
                            <fetcher.Form method="post">
                              <input
                                type="hidden"
                                name="productId"
                                value={insight.productId}
                              />
                              <input
                                type="hidden"
                                name="intent"
                                value={
                                  insight.aiStatus === "SUCCEEDED"
                                    ? "regenerate"
                                    : "generate"
                                }
                              />
                              <Button
                                variant="primary"
                                size="slim"
                                submit
                                loading={isThisGenerating}
                                disabled={isBusy}
                              >
                                {insight.aiStatus === "SUCCEEDED"
                                  ? "Regenerate AI insight"
                                  : "Generate AI insight"}
                              </Button>
                            </fetcher.Form>
                          </Box>
                        </InlineGrid>

                        {/* AI status / error */}
                        {(insight.aiStatus === "FAILED" ||
                          insight.aiStatus === "RUNNING" ||
                          insight.aiStatus === "QUEUED") && (
                          <Box paddingBlockStart="200">
                            {(insight.aiStatus === "RUNNING" ||
                              insight.aiStatus === "QUEUED") && (
                              <Text as="p" tone="subdued">
                                {getJobStatusLabel(insight.aiStatus)}
                              </Text>
                            )}
                            {insight.aiStatus === "FAILED" && insight.aiError && (
                              <Banner tone="critical" onDismiss={() => {}}>
                                {insight.aiError}
                              </Banner>
                            )}
                          </Box>
                        )}

                        {/* AI explanation */}
                        {insight.aiStatus === "SUCCEEDED" &&
                          insight.aiExplanation && (
                            <Box
                              paddingBlockStart="300"
                              paddingBlockEnd="100"
                              borderBlockStartWidth="025"
                              borderColor="border"
                            >
                              <BlockStack gap="200">
                                <Text as="p" fontWeight="medium">
                                  AI insight
                                  {insight.aiActionType && (
                                    <Text as="span" tone="subdued">
                                      {" "}
                                      · {insight.aiActionType}
                                    </Text>
                                  )}
                                </Text>
                                <Text as="p">{insight.aiExplanation}</Text>
                                {insight.reasonsJson && (
                                  <Text as="p" tone="subdued">
                                    Next steps:{" "}
                                    {(
                                      JSON.parse(
                                        insight.reasonsJson
                                      ) as string[]
                                    ).join(" · ")}
                                  </Text>
                                )}
                              </BlockStack>
                            </Box>
                          )}
                      </BlockStack>
                    </Card>
                  );
                })}
              </BlockStack>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
