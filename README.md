# F.P.T Cards

PWA mobile per registrare e confermare i prestiti di carte tra i membri del team.

## Avvio locale

La service worker richiede un server HTTP. Avviare la preview dalla cartella del progetto:

```powershell
npm run preview
```

Aprire `http://localhost:8080` nel browser.

## Sincronizzazione gratuita con Supabase

1. Creare un progetto gratuito su Supabase.
2. In **Authentication > Sign In / Providers > Email**, disattivare **Confirm email**.
3. Aprire **SQL Editor**, incollare ed eseguire `supabase-setup.sql`.
   Se lo schema base era già installato, eseguire anche `supabase-admin-upgrade.sql`.
4. Copiare Project URL e publishable/anon key in `config.js`.
5. Pubblicare i file su un hosting HTTPS gratuito.

Eseguire infine `supabase-secure-pin-upgrade.sql`: il primo PIN scelto viene associato globalmente al profilo come hash, senza usare email. Le sessioni durano 30 giorni.

Per abilitare i prestiti con più carte in una sola operazione, eseguire anche `supabase-batch-loans-upgrade.sql`.

Per salvare le miniature del catalogo nei nuovi prestiti, eseguire `supabase-card-images-upgrade.sql`.

Per completare automaticamente le miniature dei vecchi prestiti, eseguire `supabase-enrich-images-upgrade.sql`.

Per nascondere all'amministratore gli scambi tra altri membri, eseguire `supabase-private-admin-view-upgrade.sql`.

Per aggiornamenti immediati e notifiche mentre la PWA è attiva, eseguire `supabase-realtime-upgrade.sql`.

Per notifiche Web Push ad app chiusa, eseguire `supabase-web-push-upgrade.sql` e configurare le variabili Netlify descritte nella sezione Web Push.

La migration della raccolta personale/team è preparata in `supabase-milestone-2-collection.sql`, ma non è ancora applicata al database reale: eseguirla soltanto dopo la revisione pre-deploy. Aggiunge `card_printings`, `collection_items`, le RPC protette e il collegamento opzionale ai prestiti senza modificare lo storico esistente.

Dopo la migration della raccolta, eseguire `supabase-milestone-2-1-collection-loans.sql` per abilitare richieste dirette dalla Raccolta Team, accettazione parziale e stati `requested/reserved/completed/rejected`. La migration conserva `pending/returned` e `collection_item_id` nullable per i prestiti legacy.

Per abilitare Fast Scan e l’ingestion massiva, eseguire infine `supabase-milestone-3-fast-scan.sql`. Aggiunge il lookup protetto per `game + set_code` e la RPC atomica `save_collection_batch`; l’owner viene sempre ricavato dalla sessione applicativa e non dal payload client.

Per abilitare la sezione Mazzi, eseguire dopo la Raccolta `supabase-milestone-4-decks.sql`. Aggiunge mazzi personali, sezioni Main/Extra/Side e RPC protette; la disponibilità e le richieste delle carte mancanti continuano a usare l’inventario e i Prestiti esistenti.

Fast Scan usa `getUserMedia` e richiede HTTPS (oppure localhost). Tesseract.js viene preparato all’avvio dello scanner; PaddleOCR.js con PP-OCRv6 tiny interviene quando le letture Tesseract non producono un set code valido o quando Tesseract non è disponibile. Le risorse già scaricate vengono conservate nella cache OCR della PWA. Il buffer non salvato è persistito in IndexedDB e può essere ripreso dopo refresh o crash.

Il riconoscimento è esclusivamente manuale: parte soltanto premendo `Scatta e analizza`. Il loop dell'anteprima controlla la salute della camera ma non avvia mai l'OCR. Lo scatto usa i pixel del video mostrato sotto la ROI, così il ritaglio coincide con il riquadro; `ImageCapture.grabFrame()` resta un fallback. Le immagini non vengono salvate, caricate sul database o inviate al catalogo remoto; l'`ImageBitmap` e i canvas OCR vengono liberati subito dopo ogni tentativo.

Il riconoscimento usa una whitelist limitata a lettere maiuscole, cifre e trattino, con segmentazione a riga singola. Ogni snapshot manuale prova sia grayscale sia adaptive threshold prima di scegliere il risultato migliore. Non esistono pannelli DEV, telemetria OCR globale o immagini diagnostiche persistenti.

In production il codice OCR esatto ha precedenza assoluta sulle correzioni: lookup in cache sessione, RPC Supabase `card_printings`, catalogo/API esterno e fallback regionale. Il fuzzy matching viene consultato solo dopo il fallimento dell'intero lookup esatto e non può sostituire un codice valido con uno simile presente nella raccolta locale.

Prima del preprocessing viene eliminato soltanto il 5% superiore e inferiore della ROI. Il precedente ritaglio al 46% dell'altezza poteva mozzare la parte inferiore dei caratteri e impedire il riconoscimento. L'input OCR viene portato a 900 px con margine bianco, quindi il canvas temporaneo viene subito liberato.

Su Vercel gli endpoint equivalenti sono `/api/push-public-key` e `/api/send-push`. Le stesse variabili d'ambiente devono essere configurate nel progetto Vercel.

## Web Push su Netlify

Variabili richieste: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `PUSH_WEBHOOK_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

Generare le chiavi localmente eseguendo `powershell -ExecutionPolicy Bypass -File scripts/generate-vapid.ps1`, quindi copiarle direttamente nelle variabili Netlify senza inserirle nel repository.

Creare inoltre un Database Webhook Supabase per INSERT e UPDATE su `public.loans`, diretto a `https://DOMINIO/.netlify/functions/send-push`, con header `x-webhook-secret` uguale a `PUSH_WEBHOOK_SECRET`.

Senza configurazione Supabase l'app continua a funzionare in modalità locale.

## Market Watch Core (pre-deploy)

`supabase-milestone-5-market-watch.sql` è una migration additiva preparata ma **non applicata automaticamente**. Aggiunge la printing nullable ai mazzi, mapping provider, snapshot, watchlist, preferenze alert, eventi e stato sync. Le carte storiche dei mazzi restano senza printing finché un utente non la seleziona esplicitamente.

`supabase-milestone-5-1-market-watch-operational.sql` completa in modo additivo il flusso Cardmarket: target con identità locale completa, URL prodotto, prezzo a 30 giorni e RPC protetta per lo storico del grafico. Applicarla soltanto dopo la milestone 5 e prima di distribuire `market-sync`.

La funzione server-side è in `supabase/functions/market-sync/index.ts`. Prima del deploy configurare esclusivamente come secrets backend:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MARKET_SYNC_SECRET`
- `CARDTRADER_API_TOKEN`
- `CARDMARKET_PRODUCT_CATALOG_URL`
- `CARDMARKET_PRICE_GUIDE_URL`

Gli ultimi due URL devono puntare direttamente ai file ufficiali Product Catalogue e Price Guide Cardmarket, mai a pagine HTML. Se un token/feed manca, il provider viene riportato come `unavailable` senza interrompere l'applicazione.

Per Yu-Gi-Oh! i feed ufficiali correnti sono JSON (`products_singles_3.json` e `price_guide_3.json`). Il sync deriva anche il catalogo non-singles ufficiale per associare `idExpansion` al nome dell'espansione; un mapping viene risolto automaticamente solo quando nome + espansione (+ rarità, se disponibile) individuano un unico prodotto. I casi multipli restano `ambiguous`.

Lo scheduler non è attivo. `supabase-market-watch-scheduler.example.sql` contiene soltanto un esempio commentato: invoca un gate orario che procede esclusivamente alle 03:00 `Europe/Rome`, gestendo automaticamente ora solare e legale. Attivarlo solo dopo migration, secrets, deploy e collaudo manuale.

Eseguire i test core con `npm run test:market` prima del deploy.
