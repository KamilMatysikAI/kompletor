-- LOG-A-362: znacznik na powiązaniu oferty, że kanał zakończył ofertę na polecenie Kompletora (stan 0). Przy stanie
-- dodatnim Kompletor wznawia tylko taką ofertę. Tylko nowa kolumna (pusta = nie my), istniejące dane bez zmian.
-- Osobno od rejestru synchronizacji, bo „Wyślij stany ponownie” kasuje rejestr, a znacznik ma zostać.
ALTER TABLE "ChannelOffer" ADD COLUMN "endedByZeroStockAt" TIMESTAMP(3);
