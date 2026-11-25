-- LOG-A-382 E1: kategorie produktów (drzewo firmy) i kategoria produktu.
--  * "ProductCategory": drzewo kategorii firmy (rodzic, zapisana ścieżka, głębokość, kolejność); RLS jak inne tabele firmy.
--  * "Product"."categoryId" / "categorySource" / "categorySetAt": kolumny NULL, bez przepisywania danych.
-- Tylko addytywnie: żadna istniejąca kolumna ani wiersz się nie zmienia, instalacja bez danych ma puste drzewo.
BEGIN;

-- CreateTable
CREATE TABLE "ProductCategory" (
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.org_id'::text),
    "id" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "categoryId" TEXT,
ADD COLUMN "categorySetAt" TIMESTAMP(3),
ADD COLUMN "categorySource" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategory_organizationId_slug_key" ON "ProductCategory"("organizationId", "slug");
CREATE UNIQUE INDEX "ProductCategory_organizationId_id_key" ON "ProductCategory"("organizationId", "id");
CREATE UNIQUE INDEX "ProductCategory_organizationId_parentId_name_key" ON "ProductCategory"("organizationId", "parentId", "name");
CREATE INDEX "ProductCategory_organizationId_path_idx" ON "ProductCategory"("organizationId", "path");
CREATE INDEX "Product_organizationId_categoryId_idx" ON "Product"("organizationId", "categoryId");
-- korzenie (parentId NULL): unikalna nazwa w firmie (NULL w unique wyżej się nie porównuje)
CREATE UNIQUE INDEX "ProductCategory_korzen_nazwa_key" ON "ProductCategory"("organizationId", "name") WHERE "parentId" IS NULL;

-- AddForeignKey
-- klucze złożone z firmą (jak "Stock" → "Warehouse"): wiersz nie wskaże kategorii innej firmy nawet z pominięciem kodu
ALTER TABLE "Product" ADD CONSTRAINT "Product_organizationId_categoryId_fkey" FOREIGN KEY ("organizationId", "categoryId") REFERENCES "ProductCategory"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_organizationId_parentId_fkey" FOREIGN KEY ("organizationId", "parentId") REFERENCES "ProductCategory"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS jak w 00000000000000_baza: klient firmy widzi i zapisuje tylko swoje wiersze.
ALTER TABLE "ProductCategory" ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "ProductCategory" USING ("organizationId" = current_setting('app.org_id', true)) WITH CHECK ("organizationId" = current_setting('app.org_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "ProductCategory" TO logistyka_app;

COMMIT;
