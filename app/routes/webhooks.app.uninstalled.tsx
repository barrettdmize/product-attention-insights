import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const webhookId = request.headers.get("x-shopify-webhook-id");
  if (webhookId) {
    const existing = await prisma.webhookEvent.findUnique({
      where: { webhookId },
    });
    if (existing) {
      return new Response(null, { status: 200 });
    }
  }

  const { shop, session, topic } = await authenticate.webhook(request);

  if (webhookId) {
    try {
      await prisma.webhookEvent.create({
        data: { webhookId, topic, shop },
      });
    } catch {
      return new Response(null, { status: 200 });
    }
  }

  await prisma.$transaction([
    prisma.insightJob.deleteMany({ where: { shop } }),
    prisma.run.deleteMany({ where: { shop } }),
    prisma.productInsight.deleteMany({ where: { shop } }),
    prisma.session.deleteMany({ where: { shop } }),
  ]);

  return new Response(null, { status: 200 });
};
