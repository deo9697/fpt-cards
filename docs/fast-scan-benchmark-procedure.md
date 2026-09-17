# Fast Scan — procedura di benchmark manuale su telefono (v2.1 Beta)

Questo documento descrive COME eseguire il benchmark, non i risultati: nessuna
percentuale di miglioramento va dichiarata finché non è stata misurata su un
dispositivo reale (vedi `docs/ocr-audit-2026-09-16.md`). Nessuna modifica a
modello OCR, thread, preprocessing o risoluzione input va fatta prima di aver
raccolto e letto questi dati.

## Cosa misura questo benchmark

La metrica UX principale è:

> **tempo tra una scansione accettata e la possibilità di fare lo scatto
> successivo** (`readyNextMs` nel pannello debug/export) — NON il tempo fino
> alla verifica remota completa (`backgroundVerificationMs`, che prosegue in
> background e non blocca lo scatto successivo per le letture ad alta
> confidenza).

## Come attivare la strumentazione

1. Apri Fast Scan con `?debugScan=1` in coda all'URL (es.
   `https://…/#/fastscan?debugScan=1` — il parametro va nella query string
   della pagina, non nell'hash della route; se non compare il pannello debug
   provare ad aggiungerlo prima del `#`).
2. Il pannello debug (overlay sopra la fotocamera) mostra dal vivo: crop OCR
   esatto, geometria dell'ultimo scatto, e una riga di riepilogo con conteggio
   scan, p50/p95 di readyNext, p50 OCR, tassi accepted/review/not-found/
   fallback/rete, modalità di esecuzione (`WORKER`/`MAIN_THREAD_FALLBACK`/
   `WORKER_RESTARTING`/`WORKER_FAILED`), stato cache catalogo (`LOADING`/
   `PARTIAL`/`READY`/`STALE`), e i contatori di restart/timeout del worker.
3. A fine sessione, i due pulsanti nel pannello debug ("Esporta JSON" /
   "Esporta CSV") scaricano TUTTI i campioni della finestra corrente (fino a
   100 cicli) più il riepilogo aggregato — mai inviati a Supabase, restano sul
   dispositivo. Salva questi file con un nome che identifichi dispositivo/
   condizione (es. `pixel7-coldstart-wifi.json`).

Campi per ciclo (vedi anche `docs/ocr-audit-2026-09-16.md` per i limiti noti):
`sampleMs, snapshotMs, primaryPreprocessMs, primaryOcrMs, primaryResolveMs,
fallbackPreprocessMs, fallbackOcrMs, fallbackResolveMs, externalLookupMs,
parseMs, localMatchMs, commitMs, cycleTotalMs, readyNextMs, scannerLockedMs,
totalFinalizeMs, fallbackUsed, secondPassUsed, duplicate, executionMode,
cacheState, result (accepted/review/not_found), workerTimeoutCount,
workerRestartCount`. `backgroundVerificationMs` è registrato a parte (non per
ciclo) perché la verifica in background può completare molto dopo che lo
scatto è già "pronto per il prossimo" — è nel riepilogo aggregato
(`backgroundVerificationCount/P50Ms/P95Ms`), non nel campione del singolo
scatto che l'ha originata.

`readyNextMs` e `scannerLockedMs` oggi coincidono per costruzione (il
pulsante di scatto si riabilita esattamente a fine ciclo) — non è un errore
di misura, è lo stato attuale della pipeline (vedi audit, priorità 1: la rete
resta nel percorso bloccante per le letture non immediatamente forti).

## Corpus: ~50 scansioni

Usa carte reali della tua raccolta (o un piccolo set di prova), classificate
così:

| Gruppo | N | Cosa |
|---|---|---|
| A — carte normali | 20 | Codice leggibile, buona luce, nessuna ambiguità |
| B — copie consecutive | 10 | Stessa carta scattata 2+ volte di fila (stesso codice) |
| C — printing/rarità multiple | 10 | Codici che corrispondono a più stampe/rarità nel catalogo |
| D — difficili | 5 | Volutamente sfocate, riflesso/foil marcato, angolazione storta |
| E — rete lenta/offline | 5 | Con throttling di rete attivo o offline, o durante un lookup remoto volutamente ritardato |

Per il gruppo E: usa gli strumenti dev del browser (Network throttling
"Slow 3G" o "Offline") o allontanati dal Wi-Fi mentre scansioni.

## Sessioni: cold start vs warm session

Esegui l'INTERO corpus due volte, in due sessioni separate, ed esporta un
JSON/CSV per ciascuna:

1. **Cold start**: chiudi completamente l'app (swipe via dai recenti, non
   solo "torna alla home"), riapri Fast Scan da zero, prima scansione entro
   pochi secondi dall'apertura. Misura l'impatto di avvio camera+modello +
   catalogo non ancora sincronizzato.
2. **Warm session**: stessa sessione app già aperta da un po' (es. dopo aver
   navigato in Raccolta/Market Watch e poi tornato su Fast Scan), catalogo
   già sincronizzato (`cacheState` dovrebbe leggere `READY`), motore OCR già
   preparato.

Ripeti idealmente su almeno due dispositivi di fascia diversa (es. un Android
di fascia media + un iPhone), annotando modello e versione OS nel nome del
file esportato.

## Sessione prolungata (throttling/memoria)

Dopo il corpus base, esegui una sessione continuativa di almeno 15–20 minuti
di scansioni ripetute (anche solo il gruppo A in loop) per osservare se
`readyNextMs`/`primaryOcrMs` peggiorano nel tempo (throttling termico) o se
`workerRestartCount` cresce in modo anomalo (worker che si guasta ripetuta-
mente sotto carico prolungata).

## Cosa riportare

Per ciascuna sessione (cold/warm) × dispositivo:

- p50/p95 di `readyNextMs`, `primaryOcrMs`/`fallbackOcrMs` (somma),
  `backgroundVerificationMs`.
- `acceptedRate`/`reviewRate`/`notFoundRate`/`duplicateRate`/`fallbackRate`.
- `executionMode` osservato (è mai comparso `MAIN_THREAD_FALLBACK` o
  `WORKER_FAILED` senza un motivo evidente?).
- `cacheState` osservato al primo scatto di ogni sessione (in cold start è
  normale vedere `LOADING` per i primissimi scatti).
- `workerTimeoutCount`/`workerRestartCount` a fine sessione.
- Note qualitative per i gruppi D/E: quante letture difficili sono finite in
  review vs accettate erroneamente; quanto ha influito la rete lenta/offline
  sul tempo percepito (non solo sul numero).

## Criterio di accettazione per una futura modifica

Una modifica alla pipeline OCR (fuori dallo scope di questa release) si
accetta se riduce p50/p95 di `readyNextMs` o il tempo al prossimo scatto
SENZA aumentare `notFoundRate`, aggiunte errate, o perdita di voci in review
— mai sulla sola base del benchmark sintetico (`scripts/fast-scan-
performance-benchmark.mjs`), che non usa camera/PaddleOCR/rete reali.
