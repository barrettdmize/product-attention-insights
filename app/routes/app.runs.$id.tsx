import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  DataTable,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const runId = params.id;

  if (!runId) {
    throw new Response("Not found", { status: 404 });
  }

  const run = await prisma.run.findFirst({
    where: { id: runId, shop },
    include: {
      jobs: {
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!run) {
    throw new Response("Not found", { status: 404 });
  }

  const productTitles = await prisma.productInsight.findMany({
    where: {
      shop,
      productId: { in: run.jobs.map((j) => j.productId) },
    },
    select: { productId: true, productTitle: true },
  });
  const titleMap = new Map(productTitles.map((p) => [p.productId, p.productTitle]));

  const jobsWithTitles = run.jobs.map((job) => ({
    ...job,
    productTitle: titleMap.get(job.productId) ?? "Unknown",
  }));

  return { run, jobs: jobsWithTitles };
};

export default function RunDetailPage() {
  const { run, jobs } = useLoaderData<typeof loader>();

  const rows = jobs.map((job) => [
    job.productTitle,
    job.status,
    job.attempts,
    job.lastError ?? "—",
  ]);

  return (
    <Page
      title={`Run ${run.id.slice(0, 8)}…`}
      backAction={{ content: "Runs", url: "/app/runs" }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner tone="info">
              Status: {run.status} · Queued: {run.productsQueued} · Succeeded:{" "}
              {run.succeeded} · Failed: {run.failed} · Created:{" "}
              {new Date(run.createdAt).toLocaleString()}
              {run.completedAt &&
                ` · Completed: ${new Date(run.completedAt).toLocaleString()}`}
            </Banner>

            {jobs.length === 0 ? (
              <Card>
                <Text as="p">No jobs in this run.</Text>
              </Card>
            ) : (
              <Card>
                <DataTable
                  columnContentTypes={["text", "text", "numeric", "text"]}
                  headings={["Product", "Status", "Attempts", "Error"]}
                  rows={rows}
                />
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
