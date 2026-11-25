-- LOG-A-292 etap 1: archiwum zamówień sprzed odczytu kanału (raporty rok do roku). Czysto addytywne: dwie nowe tabele,
-- bez zmian w istniejących. Bez danych klienta. RLS jak w 00000000000000_baza.
BEGIN;

-- CreateTable
CREATE TABLE "ArchivedOrder" (
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.org_id'::text),
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "channelAccountId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "channelNumber" TEXT,
    "blOrderId" INTEGER,
    "status" "OrderStatus",
    "channelStatus" TEXT NOT NULL,
    "createdAtChannel" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "paymentState" "PaymentState" NOT NULL,
    "paymentMethod" TEXT,
    "totalGross" DECIMAL(12,2) NOT NULL,
    "shippingGross" DECIMAL(12,2),
    "refundGross" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "deliveryMethod" TEXT,
    "trackingNumbers" TEXT[],
    "invoiceNumbers" TEXT[],
    "sourceRevision" TEXT,
    "importRunId" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArchivedOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArchivedOrderLine" (
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.org_id'::text),
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "externalLineId" TEXT NOT NULL,
    "offerId" TEXT,
    "productId" TEXT,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "ean" TEXT,
    "qty" DECIMAL(12,3) NOT NULL,
    "lineGross" DECIMAL(12,2) NOT NULL,
    "vatRate" TEXT,
    "refundQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "refundGross" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "ArchivedOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ArchivedOrder_organizationId_createdAtChannel_idx" ON "ArchivedOrder"("organizationId", "createdAtChannel");

-- CreateIndex
CREATE INDEX "ArchivedOrder_organizationId_blOrderId_idx" ON "ArchivedOrder"("organizationId", "blOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "ArchivedOrder_organizationId_channel_channelAccountId_exter_key" ON "ArchivedOrder"("organizationId", "channel", "channelAccountId", "externalId");

-- CreateIndex
CREATE INDEX "ArchivedOrderLine_organizationId_productId_idx" ON "ArchivedOrderLine"("organizationId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ArchivedOrderLine_orderId_externalLineId_key" ON "ArchivedOrderLine"("orderId", "externalLineId");

-- AddForeignKey
ALTER TABLE "ArchivedOrder" ADD CONSTRAINT "ArchivedOrder_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArchivedOrderLine" ADD CONSTRAINT "ArchivedOrderLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArchivedOrderLine" ADD CONSTRAINT "ArchivedOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ArchivedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- RLS: klient firmy widzi tylko swoje wiersze. Aplikacja tylko czyta i wstawia/aktualizuje przy imporcie.
ALTER TABLE "ArchivedOrder" ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "ArchivedOrder" USING ("organizationId" = current_setting('app.org_id', true)) WITH CHECK ("organizationId" = current_setting('app.org_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "ArchivedOrder" TO logistyka_app;

ALTER TABLE "ArchivedOrderLine" ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "ArchivedOrderLine" USING ("organizationId" = current_setting('app.org_id', true)) WITH CHECK ("organizationId" = current_setting('app.org_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "ArchivedOrderLine" TO logistyka_app;

COMMIT;
