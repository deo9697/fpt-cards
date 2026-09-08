# Raccolte e Market Watch: correzione catalogo

Il riepilogo del batch 166b69ad-9604-455d-bebd-e9cede7f58d0 si fermava su
DUDE-EN045: Different Dimension Ground aveva lo stesso ID 31849106 della
printing italiana Terreno dell'Altra Dimensione, ma il confronto dei nomi
restituiva `mismatch`. Lo stesso problema interessava Tuning / Sintonizzare,
ID 96363153, MP24-IT055.

La migrazione `catalog_identity_localized_names` è applicata al database:
il nome tradotto non determina più l'identità. Restano i controlli sugli ID
canonici dello stesso codice stampa e dell'immagine. Nessuna quantità o UUID
di raccolta è stato cambiato. Tutte le nove righe del riepilogo (14 copie)
passano la riconciliazione; il salvataggio va ritentato dalla sessione originale.

Market Watch usa il resolver 10. Normalizza virgolette doppie/escape,
stelline e nomi equivalenti delle espansioni Collector's Tins, Hidden Arsenal
e Duelist Pack: Yusei Fudo. Gli anni delle tin rimangono distinti. Il confronto
su carta e rarità e gli stati ambigui rimangono attivi.

La funzione remota `market-sync`, versione 35, contiene questi cambiamenti
applicati alla versione remota 34. Le differenze preesistenti del repository
sui limiti di elaborazione non sono state incluse nel deploy.

Verifiche:

- `node scripts/catalog-market-names-smoke.mjs`
- `node scripts/market-watch-mw1-smoke.mjs`
- `node scripts/market-watch-core-smoke.mjs`
- `node scripts/fast-scan-p0-smoke.mjs`
- `node scripts/collection-milestone-smoke.mjs`
- `supabase/tests/catalog-identity-localized-names.sql` eseguito con rollback.
- Prova reale dei cinque casi sul feed Cardmarket: Gustav CT10-IT007,
  Jurrac Meteor, Ghost Gardna, Contact "C", LollipoYummy.
- Sincronizzazione remota dei cinque casi: 5 abbinamenti, 30 snapshot,
  zero errori. I prezzi restano dichiarati aggregati secondo i dati del provider.
- Estensione alle altre stampe irrisolte con gli stessi difetti: altri 37
  abbinamenti e 222 snapshot, zero errori. Totale: 42 stampe sbloccate.

Per ripetere la prova del feed reale, eseguire prima
`node scripts/catalog-market-diagnose.mjs`: scarica i due cataloghi pubblici
in `supabase/.temp/cardmarket-diagnostic.json`. Il test usa quel file se presente.
