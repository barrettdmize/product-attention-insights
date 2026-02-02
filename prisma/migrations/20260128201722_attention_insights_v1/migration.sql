/*
  Warnings:

  - You are about to drop the column `demandScore` on the `ProductInsight` table. All the data in the column will be lost.
  - Added the required column `attentionScore` to the `ProductInsight` table without a default value. This is not possible if the table is not empty.
  - Added the required column `lastProductUpdatedAt` to the `ProductInsight` table without a default value. This is not possible if the table is not empty.
  - Added the required column `productTitle` to the `ProductInsight` table without a default value. This is not possible if the table is not empty.
  - Added the required column `recommendation` to the `ProductInsight` table without a default value. This is not possible if the table is not empty.
  - Added the required column `status` to the `ProductInsight` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `ProductInsight` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ProductInsight" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "attentionScore" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "reasonsJson" TEXT,
    "lastProductUpdatedAt" DATETIME NOT NULL,
    "lastEvaluatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ProductInsight" ("createdAt", "id", "productId", "shop") SELECT "createdAt", "id", "productId", "shop" FROM "ProductInsight";
DROP TABLE "ProductInsight";
ALTER TABLE "new_ProductInsight" RENAME TO "ProductInsight";
CREATE INDEX "ProductInsight_shop_idx" ON "ProductInsight"("shop");
CREATE UNIQUE INDEX "ProductInsight_shop_productId_key" ON "ProductInsight"("shop", "productId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
