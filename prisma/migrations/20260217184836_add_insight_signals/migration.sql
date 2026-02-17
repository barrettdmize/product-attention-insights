-- AlterTable
ALTER TABLE "ProductInsight" ADD COLUMN "confidenceExplanation" TEXT;
ALTER TABLE "ProductInsight" ADD COLUMN "hasFeaturedImage" BOOLEAN;
ALTER TABLE "ProductInsight" ADD COLUMN "inventoryAvailable" INTEGER;
ALTER TABLE "ProductInsight" ADD COLUMN "inventoryStatus" TEXT;
ALTER TABLE "ProductInsight" ADD COLUMN "productStatus" TEXT;
