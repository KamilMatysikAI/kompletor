-- Zamówienie podjazdu kuriera z kolejki pakowania (zdolność shipment.pickup, moduł DPD z zapisem). Tylko nowa tabela:
-- istniejące dane i zachowanie bez zmian, dopóki konto przewoźnika nie ma włączonego „Zamawianie kuriera z Kompletora”.
-- Bez danych klientów (liczba i waga paczek, numer zlecenia). RLS jak w 00000000000000_baza; rola aplikacji bez
-- DELETE (historia zleceń zostaje).
BEGIN;

CREATE TABLE "CourierPickupOrder" (
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.org_id'::text),
    "id" TEXT NOT NULL,
    "carrier" "Carrier" NOT NULL,
    "adapterKey" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL DEFAULT '',
    "pickupDay" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "reference" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "fromMinute" INTEGER NOT NULL,
    "toMinute" INTEGER NOT NULL,
    "parcels" INTEGER NOT NULL,
    "weightKg" DECIMAL(10,3) NOT NULL,
    "externalRef" TEXT,
    "checkSum" TEXT,
    "lastError" TEXT,
    "failureKind" TEXT,
    "requestedBy" TEXT NOT NULL,
    "requestedName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierPickupOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourierPickupOrder_organizationId_carrier_adapterKey_accoun_key" ON "CourierPickupOrder"("organizationId", "carrier", "adapterKey", "accountKey", "pickupDay", "attempt");
CREATE UNIQUE INDEX "CourierPickupOrder_organizationId_reference_key" ON "CourierPickupOrder"("organizationId", "reference");
CREATE INDEX "CourierPickupOrder_organizationId_pickupDay_idx" ON "CourierPickupOrder"("organizationId", "pickupDay");

ALTER TABLE "CourierPickupOrder" ADD CONSTRAINT "CourierPickupOrder_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CourierPickupOrder" ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "CourierPickupOrder" USING ("organizationId" = current_setting('app.org_id', true)) WITH CHECK ("organizationId" = current_setting('app.org_id', true));
GRANT SELECT, INSERT, UPDATE ON "CourierPickupOrder" TO logistyka_app;

COMMIT;
