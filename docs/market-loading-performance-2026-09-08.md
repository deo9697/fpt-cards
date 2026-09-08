# Market Watch: tempi di caricamento

## Riscontri

- `pg_stat_statements`: `list_market_watch` media 971,4 ms su 2.388 chiamate,
  massimo 3.000,3 ms; mover media 173,9 ms; anomalie media 459,6 ms.
- Il piano eseguiva due scansioni della CTE `preferred` per ogni stampa:
  ciascuna scartava 2.127 righe, per 2.132 iterazioni.
- `EXPLAIN ANALYZE` sulla raccolta più grande: 4.858,666 ms prima,
  1.143,157 ms nella prima prova corretta e 1.979,574 ms nella verifica
  successiva al deploy. Sono tempi del database, non del caricamento sul
  dispositivo; cache e carico del server possono influenzarli.
- Confronto nello stesso statement: payload JSON vecchio e nuovo identici,
  incluse tutte le 2.132 stampe, prezzi, storico, fonti e metadati.
- Il browser costruiva tutte le righe e attendeva anche mover/anomalie
  prima di rendere disponibile la lista principale.

## Correzioni

- Migrazione `20260908203706_market_watch_reference_join.sql` applicata:
  selezione del prezzo di riferimento una sola volta, collegata con JOIN.
  Nessuna modifica ai dati o ai criteri di autorizzazione dei prezzi.
- Lista mostrata appena arriva la risposta principale. Pannelli accessori
  aggiornati successivamente; risposte di un gioco precedente ignorate.
- Primo blocco di 60 righe, pulsante per caricare altre 60. Filtri,
  ordinamento e totali continuano a usare la raccolta completa.
- Versione cache PWA incrementata a 187 per distribuire il nuovo JavaScript
  quando il frontend viene pubblicato. Frontend modificato localmente;
  questa attività non ha pubblicato il sito né creato commit.

## Verifica

- `scripts/market-watch-loading-smoke.mjs`: richieste accessorie lente,
  errore accessorio, deduplicazione, cambio gioco, 2.132 carte, pulsante
  Mostra altre e ricerca di una carta oltre il primo blocco.
- `scripts/market-watch-core-smoke.mjs` e `scripts/market-watch-mw1-smoke.mjs`.
- Advisor sicurezza: segnalazione preesistente di RPC SECURITY DEFINER
  esposta ad anon/authenticated. La funzione conserva la verifica
  `session_member(p_token)` e tutti i filtri di proprietà originali;
  privilegi e modello di autenticazione non sono stati modificati.
- Nessuna misura end-to-end sul dispositivo dell'utente.

Riferimento: [Supabase, analisi dei piani delle query](https://supabase.com/docs/guides/database/query-optimization).
