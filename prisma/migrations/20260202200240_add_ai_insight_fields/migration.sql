-- AlterTable
ALTER TABLE "ProductInsight" ADD COLUMN "aiActionType" TEXT;
ALTER TABLE "ProductInsight" ADD COLUMN "aiConfidence" TEXT;
ALTER TABLE "ProductInsight" ADD COLUMN "aiError" TEXT;
ALTER TABLE "ProductInsight" ADD COLUMN "aiExplanation" TEXT;
ALTER TABLE "ProductInsight" ADD COLUMN "aiGeneratedAt" DATETIME;
ALTER TABLE "ProductInsight" ADD COLUMN "aiModel" TEXT;
ALTER TABLE "ProductInsight" ADD COLUMN "aiStatus" TEXT;
