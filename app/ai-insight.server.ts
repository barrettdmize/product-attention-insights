/**
 * Minimal AI client for Product Attention Insights.
 * Uses OPENAI_API_KEY; no product data is written to Shopify.
 */

const OPENAI_MODEL = "gpt-4o-mini";

const ACTION_TYPES = [
  "IMAGERY",
  "PRICING",
  "COPY",
  "MERCHANDISING",
  "SEO",
  "INVENTORY",
] as const;

export type AIActionType = (typeof ACTION_TYPES)[number];

export interface AIInsightInput {
  productTitle: string;
  vendor: string | null;
  productType: string | null;
  daysSinceUpdated: number;
  status: string;
  recommendation: string;
  updatedAt: string;
  productStatus?: string;
  hasFeaturedImage?: boolean;
  inventoryStatus?: string;
  inventoryAvailable?: number;
}

export interface AIInsightOutput {
  summary: string;
  actionType: string;
  nextSteps: string[];
  caveats?: string;
}

function isValidActionType(s: string): s is AIActionType {
  return ACTION_TYPES.includes(s as AIActionType);
}

function buildPrompt(input: AIInsightInput): string {
  const isOutOfStock = input.inventoryStatus === "OUT_OF_STOCK";
  const isLowInventory = input.inventoryStatus === "LOW";
  const forceInventory = isOutOfStock;

  const productData = [
    `- Title: ${input.productTitle}`,
    `- Vendor: ${input.vendor ?? "—"}`,
    `- Product type: ${input.productType ?? "—"}`,
    `- Days since last updated: ${input.daysSinceUpdated}`,
    `- Status: ${input.status}`,
    `- Recommendation: ${input.recommendation}`,
    `- Last updated: ${input.updatedAt}`,
    input.productStatus != null ? `- Product status: ${input.productStatus}` : null,
    input.hasFeaturedImage != null ? `- Has featured image: ${input.hasFeaturedImage}` : null,
    input.inventoryStatus != null ? `- Inventory status: ${input.inventoryStatus}` : null,
    input.inventoryAvailable != null ? `- Inventory available: ${input.inventoryAvailable}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  let rules = `- Explanation: 2–4 sentences max. Explain why it's flagged and what to do next.
- actionType: exactly one of: ${ACTION_TYPES.join(", ")}
- nextSteps: 1–3 short bullet items (array of strings). No new product copy.
- caveats: optional one short sentence if data is insufficient; otherwise omit.
- If data is insufficient, say so briefly and suggest safe checks (e.g. review in admin).`;

  if (forceInventory) {
    rules = `- actionType: MUST be INVENTORY (product is out of stock).
- Focus ONLY on inventory/availability/merchandising: restock, update availability, hide from storefront if unavailable, etc. Do NOT suggest copywriting or imagery.
- nextSteps: 1–3 short bullet items about inventory/restock/visibility. No new product copy.
- caveats: optional one short sentence if data is insufficient; otherwise omit.
- Explanation: 2–4 sentences max. Explain the out-of-stock situation and inventory/availability actions.`;
  } else if (isLowInventory) {
    rules = `- actionType: prefer INVENTORY or MERCHANDISING. Mention replenishment or pausing ads if relevant.
- nextSteps: 1–3 short bullet items. No new product copy.
- caveats: optional one short sentence if data is insufficient; otherwise omit.
- Explanation: 2–4 sentences max. Explain why it's flagged and what to do next.`;
  }

  return `You are an assistant for Shopify store merchants. Based only on the following product insight data, explain why this product is flagged and what type of action the merchant should consider. Do NOT write new product descriptions or copy. Do NOT mention policies or safety. Output only valid JSON.

Product data (use only this):
${productData}

Rules:
${rules}

Return only a single JSON object with keys: summary, actionType, nextSteps, caveats (optional). No markdown, no code fence.`;
}

function parseAndValidate(
  jsonStr: string,
  forceActionType?: AIActionType
): AIInsightOutput | null {
  try {
    const raw = JSON.parse(jsonStr) as Record<string, unknown>;
    const summary = typeof raw.summary === "string" ? raw.summary : "";
    let actionType = typeof raw.actionType === "string" ? raw.actionType : "MERCHANDISING";
    if (forceActionType) actionType = forceActionType;
    const nextSteps = Array.isArray(raw.nextSteps)
      ? (raw.nextSteps as unknown[]).filter((s): s is string => typeof s === "string").slice(0, 3)
      : [];
    const caveats = typeof raw.caveats === "string" ? raw.caveats : undefined;
    if (!summary || summary.length > 1000) return null;
    return {
      summary,
      actionType: isValidActionType(actionType) ? actionType : "MERCHANDISING",
      nextSteps,
      caveats,
    };
  } catch {
    return null;
  }
}

function extractJsonFromContent(content: string): string | null {
  const trimmed = content.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

/**
 * Generate an AI explanation for a product insight. Requires OPENAI_API_KEY.
 * Returns structured output or throws with a safe message for UI.
 */
export async function generateProductInsightExplanation(
  input: AIInsightInput
): Promise<{ output: AIInsightOutput; model: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.length < 10) {
    throw new Error("OPENAI_API_KEY is not set. Add it to your .env to enable AI insights.");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "user",
          content: buildPrompt(input),
        },
      ],
      max_tokens: 500,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(
      `OpenAI API error (${response.status}): ${errBody.slice(0, 200)}`
    );
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    model?: string;
  };
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI returned no content.");
  }

  const jsonStr = extractJsonFromContent(content) ?? content;
  const forceInventory = input.inventoryStatus === "OUT_OF_STOCK";
  const output = parseAndValidate(
    jsonStr,
    forceInventory ? "INVENTORY" : undefined
  );
  if (!output) {
    throw new Error("AI response was invalid or too long. Try again.");
  }

  return { output, model: data.model ?? OPENAI_MODEL };
}
