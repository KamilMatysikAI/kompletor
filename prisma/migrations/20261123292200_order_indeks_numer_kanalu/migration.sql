-- LOG-A-292, przegląd końcowy (W-2): rozłączność archiwum z `Order` w raporcie sprzedaży (lib/archiwum/rozlacznosc.ts)
-- szuka `Order` konta po numerze zamówienia w kanale albo po id. Indeksy bez kolumny `channel`: przy RLS porównanie
-- enum nie jest leakproof, więc nie może być warunkiem indeksu (unikalny indeks konta działał tylko prefiksem firmy).
-- Czysto addytywne: dwa indeksy, bez zmian danych i RLS.
-- CreateIndex
CREATE INDEX "Order_organizationId_channelAccountId_channelNumber_idx" ON "Order"("organizationId", "channelAccountId", "channelNumber");

-- CreateIndex
CREATE INDEX "Order_organizationId_channelAccountId_externalId_idx" ON "Order"("organizationId", "channelAccountId", "externalId");
