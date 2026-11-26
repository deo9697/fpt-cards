# Pulizia storico prezzi — 26 novembre 2026

## Cosa era successo
- Il database era a **1.227 MB** su 500 MB del piano gratuito. **1.061 MB** erano `market_price_snapshots`: 1.258.781 righe, cioè 6 tipi di prezzo al giorno per circa 3.600 stampe, mai cancellate.
- Il disco era pieno (`No space left on device`): dal 23–24/11 nessuna scrittura andava a buon fine.
- Supabase ha bloccato le API del progetto con un errore `402 exceed_db_size_quota`.

## Cosa è stato fatto
1. **Backup completo** in `Desktop/PROGETTONI WOWOWOW/backup-supabase-2026-11-26/`, 133 MB compressi.
   - Script: `backup.sh` e `compact.cjs`. Ogni blocco settimanale è stato verificato contro il conteggio nel database.
   - Contenuto: 1.258.781 rilevazioni, 181.650 eventi, 21.896 prezzi attuali.
2. **Tentativo di pulizia dentro il database** (`cleanup-in-database.sql`), **fallito senza modifiche**: anche i file temporanei dell'ordinamento non avevano spazio.
3. **Metodo usato al suo posto**:
   - `keepset.cjs` calcola dal backup le righe da tenere, con le stesse regole di `public.prune_market_price_history()`.
   - `TRUNCATE ... CASCADE` su snapshot, eventi e prezzi attuali.
   - `restore.cjs` reinserisce le righe da tenere a blocchi di 800, a trigger disattivati: 151.964 rilevazioni e 21.896 prezzi attuali.
   - Gli eventi **non** sono stati reinseriti: nessuna funzione e nessuna pagina li legge, e restano nel backup.
4. **Migration** `20261126150000_market_history_retention_and_quota.sql`:
   - pulizia ogni notte alle 02:50 UTC;
   - eventi solo per il trend;
   - avviso agli admin al 70%, 80% e 90% della quota, ogni giorno alle 04:00 UTC.

**Risultato:** 243 MB (48,5%), nessun prezzo attuale orfano, tutti e 4 i trigger attivi.

## Regole dello storico
| Cosa | Quanto si tiene |
|---|---|
| Trend | 1 al giorno per 30 giorni, 1 a settimana fino a 90 giorni, 1 al mese oltre |
| Altri tipi (medie, minimo) | le ultime 2 rilevazioni |
| Sempre | prezzi attuali, anomalie |
| Eventi | 14 giorni |

## Ripristinare dal backup
Per ripristinare una parte dei dati, usa `restore.cjs` con un file `.ndjson.gz` diverso, oppure `jsonb_populate_recordset` a blocchi da 800 righe: una richiesta oltre circa 1 MB riceve l'errore 413.
