# Fast Scan: identità fisica e rarità — 2026-10-11

La correzione impedisce al Fast Scan di trasformare una rarità sconosciuta in Common e di considerare completa una stampa locale quando le evidenze disponibili indicano varianti mancanti. Nessuna modifica live, inserimento catalogo, stage, commit, push o deploy.

## Riproduzione e cause distinte

| Codice | Catalogo live letto | Vecchio scanner, replay locale | Nuovo comportamento |
| --- | --- | --- | --- |
| BLGG-EN012 Dragunity Falchion | 1 riga Common, UUID `331aabd6-cc35-40b7-bb32-592c99231fac` | EXACT_UNIQUE Common | CATALOG_VARIANT_INCOMPLETE; Common non selezionabile; Ultra richiede riparazione catalogo |
| RA05-EN027 Imsety | 1 riga Ultimate Rare, UUID `9b06b35a-95a6-450e-9725-acececf1e8c7` | EXACT_UNIQUE Ultimate | CATALOG_VARIANT_INCOMPLETE; sette opzioni, sei mancanti |
| RA05-EN007 Delta | Nessuna riga | Nessun match in cache | Ricerca normale; CATALOG_MISSING se confermata assenza; nessuna stampa inventata |
| RA05-EN007, fixture con unica Ultra | 1 riga sintetica Ultra | EXACT_UNIQUE Ultra | CATALOG_VARIANT_INCOMPLETE |
| BLGG-EN004, fixture con Secret + Starlight | 2 righe sintetiche | Revisione generica | RARITY_AMBIGUOUS |

La riga Common di Falchion è già errata nel DB: il replay ne dimostra la propagazione, non quale import l'abbia creata. Separatamente, il vecchio `sanitizeYugiohRarity` trasformava New/Reprint in Common nei percorsi di buffer, ripristino e salvataggio. Entrambi i problemi sono coperti. Non è dimostrabile che l'Ultra riportata dal dispositivo per Imsety provenisse dai dati attuali: il DB letto contiene Ultimate. La fixture con Ultra riproduce il meccanismo, non la sessione storica.

Percorso: OCR → `normalizeSetCode` → indice/session cache → `mapPrinting` → `classifyPrintingMatch` o `classifyNearPrintingMatch` → revisione/conferma → `ScanSessionBuffer` → `canonicalizeFastScanEntries` → payload batch. Prima bastava `matches.length === 1`; ora il controllo delle evidenze fisiche precede l'accettazione. La cache di sessione non può nascondere varianti già presenti nell'indice.

## Fonti primarie

- [Konami: Dragunity Falchion](https://www.db.yugioh-card.com/yugiohdb/card_search.action?cid=22197&ope=2): BLGG-EN012 **Ultra Rare**, non una coppia Secret/Starlight.
- [Konami: Vampire Lord](https://www.db.yugioh-card.com/yugiohdb/card_search.action?cid=5410&ope=2&request_locale=en): BLGG-EN004 Secret e Starlight, fixture concreta multirarity.
- [Konami: Imsety](https://www.db.yugioh-card.com/yugiohdb/card_search.action?cid=19153&ope=2&request_locale=en) e [Delta](https://www.db.yugioh-card.com/yugiohdb/card_search.action?cid=12071&ope=2&request_locale=en): i due codici RA05 hanno sette rarità.
- [Prodotto BLGG](https://www.yugioh-card.com/eu/product/battles-of-legend-glorious-gallery/) e [RA05](https://www.yugioh-card.com/eu/product/rarity-collection-5/): non applicare indiscriminatamente le sette rarità anche alle extended art o la coppia Secret/Starlight a ogni BLGG.

## Audit del modello e limiti

Lettura di 181 righe, 163 gruppi `(set_code, catalog_card_id, card_name)`: BLGG 104 righe/102 gruppi (2 multiriga); RA05 77 righe/61 gruppi (11 multiriga). Il vincolo UNIQUE è `(game, catalog_card_id, set_code, rarity, variant_id)`: il modello consente le varianti, i dati sono un **mix parziale dipendente dalle fonti**, non una riga obbligatoria per codice.

Il dettaglio completo con codici, nomi, ID, conteggi, rarità, variant_id, fonti, verifica e metadata è in [grouped-catalog.json](audit-snapshots/scan-rarity-2026-10-11/grouped-catalog.json); le righe originali e il corpo dell'indice in [live-readonly.json](audit-snapshots/scan-rarity-2026-10-11/live-readonly.json). `verified` nel DB non dimostra completezza delle rarità. Nei tre casi EN segnalati non sono disponibili metadata che risolvano il problema.

`list_catalog_printings_index` conserva gli UUID separati, ma non espone variant_id/game_metadata/fonti. Anche la definizione locale di lookup per codice è compatta. Il client conserva i metadata quando disponibili e non fonde le varianti; non viene modificato il contratto SQL in questa tranche. La selezione non può ricostruire metadata omessi dal backend: un mismatch durante il salvataggio viene rifiutato.

Le evidenze integrate sono specifiche per i quattro codici verificati e accettano anche `expectedRarities` / `game_metadata.expected_rarities`. Gli altri singoli match RA05/BLGG senza evidenza di completezza vanno in revisione. Non è una certificazione dell'intero catalogo: altri set con varianti upstream sconosciute richiedono audit/import delle evidenze. Nessuna identificazione visiva della foil.

## Semantica, UI e salvataggio

- Stampa unica con rarità esplicita: EXACT_UNIQUE, compresa Common reale.
- Rarità differenti: RARITY_AMBIGUOUS; artwork della stessa identità: ARTWORK_AMBIGUOUS (resta compatibile il chooser artwork esistente).
- Varianti note assenti o rarità contraddetta dalla fonte: CATALOG_VARIANT_INCOMPLETE.
- Vuoto, Unknown, numeri, New/Reprint e relative note: UNKNOWN_RARITY/revisione; mai Common.
- Il chooser mostra tutte le opzioni, senza il precedente limite di quattro. Le opzioni assenti indicano che serve una correzione catalogo; non hanno UUID copiati dalla variante esistente.
- Selezionare una variante assente mantiene la revisione con REQUIRES_CATALOG_REPAIR. Una riga esistente scelta esplicitamente è salvabile solo dopo verifica dell'identità.
- Il salvataggio confronta UUID, gioco, catalog_card_id, codice, rarità, variant_id e artwork_id disponibili. Nessun fallback Starlight→Ultra. Senza printing esistente non crea righe Yu-Gi-Oh implicitamente.
- Il nome da solo non permette di cambiare catalog_card_id/artwork. Restano gli alias espliciti del catalogo. Le righe rifiutate rimangono locali e non bloccano le altre righe valide.
- Una verifica per codice distinto in ciascun salvataggio, condivisa fra le sue rarità; questo aggiunge letture rispetto al precedente salvataggio senza verifica. I test di batch coprono 228 identità e chunk da 25. Le letture non sono sul ciclo OCR.

Audit Common: i vecchi fallback fisici in sanitizer, normalizzazione printings, fallback sorgente, buffer/ripristino e canonicalizzazione erano UNSAFE_PHYSICAL_PRINTING_DEFAULT e sono stati rimossi. La compatibilità numerica dell'helper generico `normalizeCatalogRarity` resta separata (SAFE_DEFAULT solo per la sua semantica legacy, testata); nessun percorso fisico Fast Scan può raggiungerla con un numero, perché il sanitizer lo rifiuta prima. Common esplicita resta valida. Nessun altro fallback Common è presente nei moduli scanner.

## File della correzione

Runtime: `js/cards.js`, `js/fast-scan-core.js`, `js/fast-scan.js`, `js/fast-scan-sync.js`, `js/fast-scan-catalog-cache.js`, nuovo `js/fast-scan-printing-identity.js`; in `sw.js` soltanto la voce precache del nuovo modulo appartiene a questa correzione.

Test: nuovo `scripts/fast-scan-rarity-identity-smoke.mjs`; aggiornati `fast-scan-save-hardening-smoke.mjs`, `fast-scan-artwork-variant-smoke.mjs`, `fast-scan-milestone-smoke.mjs`, `fast-scan-ocr-confusions-smoke.mjs`, `printing-editor-integrity-smoke.mjs`, `fixtures/fast-scan-stabilization-corpus.json`. I fixture OCR ora dichiarano una rarità valida; le vecchie aspettative Common inventata/insert implicito sono sostituite da rifiuto e conservazione locale. Il fixture di riparazione ID usa un alias registrato, non un cambio ID basato sul solo nome.

## Verifica finale

Worktree 61/61 PASS; installazione pulita isolata 61/61 PASS; Market 24/24 in entrambe; nuova regressione rarità 32/32; precedente regressione catalogo 27/27. `printing-editor-integrity-smoke.mjs`, esterno al runner delle 61 suite, passa in entrambe le copie. Due test browser sono stati ripetuti: uno per la transizione temporizzata della schermata di review, uno dopo ERR_CONNECTION_REFUSED durante il cambio del preview server verso la copia isolata; entrambi passano senza modifiche applicative.

SAFE TO COMMIT STABILIZATION TRANCHE = YES, esclusivamente tramite il manifest aggiornato e le estrazioni package/lock/sw. SAFE TO COMMIT ENTIRE WORKTREE = NO. SAFE TO DEPLOY = NO. Questa decisione non autorizza né esegue il commit.

Risultati e hash conclusivi sono in `artifacts/scan-rarity-2026-10-11/verification.json`, con manifest `prepared.json`, log worktree `tests/` e log installazione isolata `clean-install-tests/`. La copia isolata riusa esclusivamente l'estrazione package/lock del 10 ottobre, con `npm ci --offline --ignore-scripts --no-audit --no-fund` (27 pacchetti). Il resto del worktree e le modifiche pregresse di sw.js sono esclusi.

Non cambiano il piano catalogo 127 mancanti / 18 falsi positivi / 18 speciali, le migrazioni, Market o i dati live. Deploy resta escluso finché non vengono completati riconciliazione migration drift, verifica su dispositivo reale, revisione riparazioni catalogo e piano rollout.
