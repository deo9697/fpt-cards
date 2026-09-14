# Ricerca bilingue della Raccolta

Il filtro cercava esclusivamente cardName, setCode, setName e rarity; il read
model delle RPC list_my_collection/list_team_collection non fornisce nomi
localizzati Yu-Gi-Oh. mapCollectionItem inoltre non esponeva alias testuali.
La logica IT/EN in cards.js è usata per lookup remoti e non è adatta al filtro
live. La raccolta pubblica usa già alternateNames provenienti da altre printing,
ma questa fonte non garantisce una traduzione per ogni carta.

La patch aggiunge searchAliases al mapping degli item, riutilizzando eventuali
game_metadata.localizedName/searchAliases e un dizionario locale EN/IT. Il filtro
usa lo stesso dizionario anche per gli item legacy già memorizzati sul dispositivo.
Solo il gioco yugioh usa questo dizionario, con corrispondenza esatta del catalog ID;
nessuna modifica a ID, printing, artwork, pricing o nomi visualizzati.

`node scripts/build-collection-search-aliases.mjs` rigenera il dizionario durante
l'aggiornamento del catalogo/build: effettua due download dal provider già usato
in cards.js (EN e IT), associa i nomi per ID e scarta risultati incompleti.
Non viene eseguito dall'app. Il modulo generato è incluso nella cache PWA e non
introduce chiamate runtime a YGOPRODeck. Aggiornare e distribuire il dizionario
quando arrivano nuove traduzioni. Nessuna migration o backfill DB necessario.

Copertura iniziale: 10.933 coppie del provider più un alias revisionato:
44265115, Brain Controller / Controlla Cervello, fornito nella richiesta FPT.
L'endpoint inglese conferma l'ID e ALIN-EN033; quello italiano non ha ancora
una voce. Nessuna traduzione automatica viene inventata per le carte mancanti.
Per gli ID senza alias restano ricercabili nome salvato, set code, set e rarità.

La normalizzazione locale elimina accenti, uniforma maiuscole, apostrofi,
trattini e spazi. I campi sono separati per evitare corrispondenze che attraversino
due nomi diversi. Non è fuzzy matching. Query normalizzata una volta per filtro;
nessun effetto collaterale o Promise nel matching. Durante la digitazione viene
anche sospeso il prefetch decorativo dei tipi carta, separato dalla ricerca.

Verifica: `node scripts/collection-search-smoke.mjs` copre IT/EN, alias del
dizionario reale, normalizzazione, legacy, isolamento One Piece, falsi positivi,
metadati, raccolta personale/team e zero fetch. Include una misura su 5.000 item.
`node scripts/collection-milestone-smoke.mjs` verifica le regressioni esistenti.

## Aggiornamenti e alias revisionati

Gli alias manuali sono in scripts/data/collection-search-reviewed-aliases.json,
con gioco, ID esatto, nome inglese atteso, fonte e data di revisione. Il build
fallisce se il nome inglese non coincide: nessuna riassegnazione silenziosa.
I nomi precedenti vengono conservati come sinonimi e segnalati nel report.
I cali anomali di copertura bloccano la generazione. Dopo il build verificare
changedIds e retainedAliases in docs/collection-alias-coverage.json prima di
pubblicare. Il report corrente elenca 2.959 carte senza voce italiana; una voce
italiana con lo stesso nome inglese conta invece come coperta.

Al caricamento della raccolta, enrichCollectionAliases unisce i nomi delle
printing personali e del team gi? disponibili per lo stesso gioco/ID esatto.
Nessuna nuova lettura DB: la copertura ? limitata ai dati autorizzati gi? caricati.
Non unisce item senza ID e non modifica gli oggetti originali o i nomi mostrati.
Gli alias arricchiti seguono la persistenza locale esistente della raccolta.

Per dare priorit? alle proprie carte mancanti:
node scripts/report-collection-alias-gaps.mjs percorso/collection.json
Il file pu? essere un array di item o un oggetto con mine. Il report locale
raggruppa le printing senza traduzione confermata nel dizionario per ID e
le ordina per frequenza, conservando eventuali nomi gi? conosciuti. Non presume
che un nome locale alternativo sia italiano senza una verifica linguistica.
Nessun export personale ? incluso nel repository.

Test aggiuntivi: scripts/collection-alias-build-smoke.mjs verifica aggiornamenti,
alias revisionati, nomi identici EN/IT, ID brevi, isolamento tra giochi,
arricchimento senza mutazioni, idempotenza e priorit? delle carte mancanti.
scripts/collection-search-browser-smoke.mjs usa il vero gestore input e verifica
anche cancellazione query e assenza di prefetch decorativo durante la ricerca.
