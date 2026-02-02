import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { Page, Layout, Card, DataTable } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import type { ProductInsightStatus } from "@prisma/client";

const PRODUCTS_FIRST = 25;

/** Naive attention score: days since product was last updated. Higher = more neglected. */
function getDaysSinceUpdated(updatedAt: string): number {
  const updated = new Date(updatedAt).getTime();
  const now = Date.now();
  return Math.floor((now - updated) / (1000 * 60 * 60 * 24));
}

function getStatusAndRecommendation(
  daysSinceUpdated: number
): { status: ProductInsightStatus; recommendation: string } {
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
    recommendation: "Update description, images, or pricing to re-engage customers.",
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const response = await admin.graphql(
    `#graphql
      query GetProductsForInsights($first: Int!) {
        products(first: $first, sortKey: UPDATED_AT, reverse: false) {
          nodes {
            id
            title
            updatedAt
          }
        }
      }`,
    { variables: { first: PRODUCTS_FIRST } }
  );

  const json = await response.json();
  const nodes = json?.data?.products?.nodes ?? [];

  for (const node of nodes) {
    const daysSinceUpdated = getDaysSinceUpdated(node.updatedAt);
    const { status, recommendation } = getStatusAndRecommendation(daysSinceUpdated);

    await prisma.productInsight.upsert({
      where: {
        shop_productId: { shop, productId: node.id },
      },
      create: {
        shop,
        productId: node.id,
        productTitle: node.title ?? "Untitled",
        attentionScore: daysSinceUpdated,
        status,
        recommendation,
        lastProductUpdatedAt: new Date(node.updatedAt),
      },
      update: {
        productTitle: node.title ?? "Untitled",
        attentionScore: daysSinceUpdated,
        status,
        recommendation,
        lastProductUpdatedAt: new Date(node.updatedAt),
        lastEvaluatedAt: new Date(),
      },
    });
  }

  const insights = await prisma.productInsight.findMany({
    where: { shop },
    orderBy: { attentionScore: "desc" },
  });

  return { insights };
};

export default function InsightsPage() {
  const { insights } = useLoaderData<typeof loader>();

  const rows = insights.map((insight) => [
    insight.productTitle,
    String(insight.attentionScore),
    insight.status.replace(/_/g, " ").toLowerCase(),
    insight.recommendation,
  ]);

  return (
    <Page title="Product Attention Insights">
      <Layout>
        <Layout.Section>
          <Card>
            {insights.length === 0 ? (
              <p>No product insights yet. Add products in your store and refresh.</p>
            ) : (
              <DataTable
                columnContentTypes={["text", "numeric", "text", "text"]}
                headings={[
                  "Product",
                  "Days since updated",
                  "Status",
                  "Recommendation",
                ]}
                rows={rows}
              />
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
