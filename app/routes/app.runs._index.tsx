import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  DataTable,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const runs = await prisma.run.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return { runs };
};

export default function RunsIndexPage() {
  const { runs } = useLoaderData<typeof loader>();

  const rows = runs.map((run) => [
    <Link key={run.id} to={`/app/runs/${run.id}`}>
      {run.id.slice(0, 8)}…
    </Link>,
    run.status,
    run.productsQueued,
    run.succeeded,
    run.failed,
    new Date(run.createdAt).toLocaleString(),
    run.completedAt
      ? new Date(run.completedAt).toLocaleString()
      : "—",
  ]);

  return (
    <Page title="Runs">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Text as="p" tone="subdued">
              Recent AI insight batch runs. Click a run to see per-product outcomes.
            </Text>
            {runs.length === 0 ? (
              <Card>
                <Text as="p">No runs yet. Generate AI for products on the Insights page.</Text>
              </Card>
            ) : (
              <Card>
                <DataTable
                  columnContentTypes={[
                    "text",
                    "text",
                    "numeric",
                    "numeric",
                    "numeric",
                    "text",
                    "text",
                  ]}
                  headings={[
                    "Run",
                    "Status",
                    "Queued",
                    "Succeeded",
                    "Failed",
                    "Created",
                    "Completed",
                  ]}
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
