/**
 * Pure helpers for product insight signals and confidence.
 */

export type ProductStatus = "ACTIVE" | "DRAFT" | "ARCHIVED";

export type InventoryStatus = "OUT_OF_STOCK" | "LOW" | "OK" | "UNKNOWN";

const LOW_INVENTORY_THRESHOLD = 10;

/**
 * Compute inventory status from available quantity.
 * totalAvailable: sum of variant inventory (or null if not available).
 */
export function computeInventoryStatus(
  totalAvailable: number | null
): InventoryStatus {
  if (totalAvailable === null || totalAvailable === undefined) {
    return "UNKNOWN";
  }
  if (totalAvailable <= 0) return "OUT_OF_STOCK";
  if (totalAvailable <= LOW_INVENTORY_THRESHOLD) return "LOW";
  return "OK";
}

export interface ConfidenceInput {
  hasStatus: boolean;
  hasImage: boolean;
  hasInventory: boolean;
  daysSinceUpdated: number;
}

/**
 * Deterministic confidence score 0.10–0.95 based on signal presence/quality.
 */
export function computeConfidence(input: ConfidenceInput): number {
  let score = 0.5;
  if (input.hasStatus) score += 0.15;
  if (input.hasImage) score += 0.15;
  if (input.hasInventory) score += 0.15;
  if (input.daysSinceUpdated >= 0 && input.daysSinceUpdated < 365) score += 0.05;
  return Math.min(0.95, Math.max(0.1, score));
}

export type ConfidenceLabel = "High" | "Medium" | "Low";

export function getConfidenceLabel(score: number): ConfidenceLabel {
  if (score >= 0.8) return "High";
  if (score >= 0.55) return "Medium";
  return "Low";
}

export type MissingSignal =
  | "status"
  | "image"
  | "inventory";

/**
 * Build explanation for low confidence.
 */
export function buildConfidenceExplanation(
  missingSignals: MissingSignal[]
): string {
  if (missingSignals.length === 0) return "";
  const parts: string[] = [];
  if (missingSignals.includes("status")) parts.push("product status");
  if (missingSignals.includes("image")) parts.push("featured image");
  if (missingSignals.includes("inventory")) parts.push("inventory data");
  return `Low confidence: missing ${parts.join(" and ")}.`;
}
