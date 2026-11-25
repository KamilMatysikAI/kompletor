-- LOG-A-292 etap 3: archiwum z faktur BaseLinkera. Czysto addytywne: jedna kolumna z wartością domyślną (wiersze z
-- etapów 1–2 dostają false, czyli kanał podany przez źródło). Bez zmian RLS (tabela ma już politykę).
ALTER TABLE "ArchivedOrder" ADD COLUMN "channelInferred" BOOLEAN NOT NULL DEFAULT false;
