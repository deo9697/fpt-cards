# Market Watch: verifica aggiuntiva

All'inizio del controllo: 2.248 stampe monitorate, 112 senza snapshot.
62 non avevano ancora una mappatura, 46 erano irrisolte, 4 ambigue.
La raccolta ha continuato a crescere durante il controllo: i conteggi finali
non vanno confrontati come se l'inventario fosse rimasto fermo.

## Cause e correzioni attive

- Il lettore dei prodotti sigillati conservava solo il nome più corto per
  espansione, perdendo i nomi dei mazzi in favore dei pack aggiuntivi o dei
  value box. Ora conserva e confronta tutti i nomi dell'espansione.
- Aggiunti confronti per vecchi Starter Deck, espansioni italiane MIY/MIK/SDF,
  Gold Series, Dark Revelation, Zexal e Legendary Collection 4.
- Normalizzati caratteri invisibili, Maliss, Falchion Beta e nomi provvisori
  di carte BLGG. Le espansioni OCG/giapponesi e le edizioni locali restano distinte.
- Corrette tre righe BLGG con nomi provvisori e rarità `New`/`Common`: le
  stampe ufficiali BLGG-EN046/048 sono Ultra Rare. UUID e quantità preservati.
- Le mappature irrisolte vengono riprovate nel ciclo notturno anche senza
  modificare la versione del resolver. Le conferme manuali restano protette.
- Attivato il job `fpt-market-refresh-queue` ogni 15 minuti: tratta fino a
  100 nuove stampe per ciclo e aggiorna le conferme manuali in attesa.
  Se non ci sono richieste, non scarica i feed. Il refresh completo resta notturno.
- Indicizzato il catalogo per nome per evitare una scansione completa per
  ogni stampa: il primo tentativo completo aveva raggiunto il limite CPU.

## Verifiche

Resolver 11, Edge Function `market-sync` versione 40. Il deploy preserva i
limiti remoti preesistenti (1500); la modifica locale preesistente a 50000
non è stata inclusa. Migrazioni applicate:

- `market_refresh_queue_schedule`
- `market_verified_blgg_metadata`

Test superati:

- `scripts/catalog-market-names-smoke.mjs`, anche sul feed pubblico reale.
- `scripts/market-watch-mw1-smoke.mjs`
- `scripts/market-watch-core-smoke.mjs`
- Benchmark reale: 2.266 stampe in 649 ms per la risoluzione locale.
- Ricalcolo remoto completo, richiesta 308: 2.403 stampe, 14.356 snapshot,
  risposta HTTP 200, 10 target non aggiornabili in quel momento.
- Richiesta 309: le tre ulteriori stampe (due Shaddoll BLGG e DNA Surgery SDF)
  risolte con 18 snapshot e zero errori.
- Richiesta 310: HTTP 546 durante il secondo ciclo della coda; il primo aveva
  completato 11 stampe e 66 snapshot. La versione 40 unifica nuove stampe e
  richieste prioritarie in un solo ciclo, fino a 100 target, e usa solo il
  listino se tutti gli abbinamenti sono già autorizzati. Recuperato soltanto
  il lock della richiesta interrotta, identificata tramite UUID.
- Richiesta 312, coda unificata: HTTP 200, 42 stampe, 252 snapshot, zero errori.
- Richiesta 313: HTTP 200, coda vuota, nessun download del catalogo/listino.
- Copertura dopo il recupero: 2.410 stampe con prezzo su 2.417 monitorate.

I sette blocchi residui identificati sono quattro R.B. DUAD-IT090/091/092/095
senza rarità/espansione verificabile e i tre Dei Egizi LC01 Ultra Rare, ambigui
rispetto alle altre varianti presenti nel catalogo. Le nuove stampe inserite
durante la verifica passano invece nella coda automatica.

## Fonti per le correzioni dei metadati

- [Konami: Shadowreaver Knight 21, BLGG-EN046](https://www.db.yugioh-card.com/yugiohdb/card_search.action?cid=22501&ope=2&request_locale=en)
- [Konami: First Striker Advantage, BLGG-EN048](https://www.db.yugioh-card.com/yugiohdb/card_search.action?cid=22503&ope=2&request_locale=en)
- [Konami: El Shaddoll Meshachrer](https://www.db.yugioh-card.com/yugiohdb/card_search.action?cid=22207&ope=2&request_locale=es)
- I nomi delle espansioni e dei prodotti sono verificati nei feed pubblici
  `products_singles_3.json` e `products_nonsingles_3.json` di Cardmarket.
