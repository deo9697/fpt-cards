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

Per notifiche Web Push ad app chiusa, eseguire `supabase-web-push-upgrade.sql` e configurare le variabili Vercel descritte nella sezione Web Push.

La migration della raccolta personale/team è preparata in `supabase-milestone-2-collection.sql`, ma non è ancora applicata al database reale: eseguirla soltanto dopo la revisione pre-deploy. Aggiunge `card_printings`, `collection_items`, le RPC protette e il collegamento opzionale ai prestiti senza modificare lo storico esistente.

Dopo la migration della raccolta, eseguire `supabase-milestone-2-1-collection-loans.sql` per abilitare richieste dirette dalla Raccolta Team, accettazione parziale e stati `requested/reserved/completed/rejected`. La migration conserva `pending/returned` e `collection_item_id` nullable per i prestiti legacy.

Per abilitare Fast Scan e l’ingestion massiva, eseguire infine `supabase-milestone-3-fast-scan.sql`. Aggiunge il lookup protetto per `game + set_code` e la RPC atomica `save_collection_batch`; l’owner viene sempre ricavato dalla sessione applicativa e non dal payload client.

Per abilitare la sezione Mazzi, eseguire dopo la Raccolta `supabase-milestone-4-decks.sql`. Aggiunge mazzi personali, sezioni Main/Extra/Side e RPC protette; la disponibilità e le richieste delle carte mancanti continuano a usare l’inventario e i Prestiti esistenti.

Fast Scan usa `getUserMedia` e richiede HTTPS (oppure localhost). La preparazione di PaddleOCR.js con PP-OCRv6 tiny parte insieme alla fotocamera. Le risorse già scaricate vengono conservate nella cache OCR della PWA. Il buffer non salvato è persistito in IndexedDB e può essere ripreso dopo refresh o crash.

Il riconoscimento è esclusivamente manuale: parte soltanto premendo `Scatta e analizza`. Il loop dell'anteprima controlla la salute della camera ma non avvia mai l'OCR. Lo scatto usa i pixel del video mostrato sotto la ROI, così il ritaglio coincide con il riquadro; `ImageCapture.grabFrame()` resta un fallback. Le immagini non vengono salvate, caricate sul database o inviate al catalogo remoto; l'`ImageBitmap` e i canvas OCR vengono liberati subito dopo ogni tentativo.

Ogni scatto attende un nuovo fotogramma e parte dal grayscale. Una lettura valida con confidence almeno 88 (la soglia già usata dal consenso, ancora da calibrare sui dispositivi) evita il secondo OCR, anche per copie consecutive o rarità ambigue. L'adaptive viene preparato soltanto per letture deboli/non valide; letture deboli o discordanti richiedono review anche se il codice esiste nel catalogo. La normalizzazione filtra il testo restituito: il motore non è configurato con una whitelist o una segmentazione single-line. `?debugScan=1` abilita crop e telemetria locali, incluse le metriche del motore quando disponibili; nessuna immagine diagnostica viene persistita.

Se il codice non è nella cache verificata, ogni scatto viene prima persistito come voce "in verifica" e risolto in background, una carta alla volta. Copie intenzionali mantengono voci e quantità distinte. Il salvataggio finale attende le verifiche pendenti; è possibile ignorarle, e una risposta tardiva non le ripristina. Dopo un refresh le verifiche interrotte restano nella review, correggibili con Cerca. Ogni attesa RPC/provider ha un limite applicativo di 15 secondi: un timeout non autorizza correzioni fuzzy. Le richieste sottostanti non sono necessariamente annullate dal provider.

Il worker OCR ha limiti di 60 secondi per la preparazione e 15 secondi per inferenza. In caso di errore viene terminato e ricreato al tentativo successivo, senza passare automaticamente al thread UI. Se il browser non può avviare il worker, rimane disponibile l'inserimento manuale. La cache catalogo pubblica solo snapshot completi, con una singola scrittura per sync; le sync concorrenti condividono il download. Dopo 24 ore ricostruisce lo snapshot per recuperare modifiche e cancellazioni.

In production il codice OCR esatto ha precedenza assoluta sulle correzioni: lookup in cache sessione, RPC Supabase `card_printings`, catalogo/API esterno e fallback regionale. Il fuzzy matching viene consultato solo dopo il fallimento dell'intero lookup esatto e non può sostituire un codice valido con uno simile presente nella raccolta locale.

Prima del preprocessing viene eliminato soltanto il 5% superiore e inferiore della ROI. Il precedente ritaglio al 46% dell'altezza poteva mozzare la parte inferiore dei caratteri e impedire il riconoscimento. L'input OCR viene portato a 900 px con margine bianco, quindi il canvas temporaneo viene subito liberato.

Regressioni del percorso OCR: `npm run test:fast-scan-ocr-pipeline`. I test usano camera/modello/rete controllati e non sostituiscono una misura su telefono. Il benchmark `test:fast-scan-performance` misura soltanto preprocessing sintetico, non la durata di inferenza reale.

## Web Push su Vercel

Gli endpoint sono `/api/push-public-key` e `/api/send-push` (vedi `api/`).

Variabili richieste: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `PUSH_WEBHOOK_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

Generare le chiavi localmente eseguendo `powershell -ExecutionPolicy Bypass -File scripts/generate-vapid.ps1`, quindi copiarle direttamente nelle variabili d'ambiente del progetto Vercel senza inserirle nel repository.

Creare inoltre un Database Webhook Supabase per INSERT e UPDATE su `public.loans`, diretto a `https://DOMINIO/api/send-push`, con header `x-webhook-secret` uguale a `PUSH_WEBHOOK_SECRET`.

Se è stato applicato anche `supabase-notifications-center.sql` (usato da market alert, condivisione raccolta, ecc.), creare un secondo Database Webhook per INSERT su `public.notifications`, diretto allo stesso `https://DOMINIO/api/send-push` con lo stesso header — senza questo webhook, `/api/send-push` non viene mai chiamato per queste notifiche e restano solo in-app (visibili in Altro → Richieste/notifiche, ma senza push).

Senza configurazione Supabase l'app continua a funzionare in modalità locale.

## Market Watch Core (pre-deploy)

`supabase-milestone-5-market-watch.sql` è una migration additiva preparata ma **non applicata automaticamente**. Aggiunge la printing nullable ai mazzi, mapping provider, snapshot, watchlist, preferenze alert, eventi e stato sync. Le carte storiche dei mazzi restano senza printing finché un utente non la seleziona esplicitamente.

`supabase-milestone-5-1-market-watch-operational.sql` completa in modo additivo il flusso Cardmarket: target con identità locale completa, URL prodotto, prezzo a 30 giorni e RPC protetta per lo storico del grafico. Applicarla soltanto dopo la milestone 5 e prima di distribuire `market-sync`.

La funzione server-side è in `supabase/functions/market-sync/index.ts`. Prima del deploy configurare esclusivamente come secrets backend:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MARKET_SYNC_SECRET`
- `CARDMARKET_PRODUCT_CATALOG_URL`
- `CARDMARKET_PRICE_GUIDE_URL`

I due URL devono puntare direttamente ai file ufficiali Product Catalogue e Price Guide Cardmarket, mai a pagine HTML. Se il feed manca, il provider viene riportato come `unavailable` senza interrompere l'applicazione. Cardmarket è l'unica fonte prezzi: CardTrader è stato rimosso, i collezionisti fanno riferimento a Cardmarket come mercato di riferimento.

Per Yu-Gi-Oh! i feed ufficiali correnti sono JSON (`products_singles_3.json` e `price_guide_3.json`). Il sync deriva anche il catalogo non-singles ufficiale per associare `idExpansion` al nome dell'espansione; un mapping viene risolto automaticamente solo quando nome + espansione (+ rarità, se disponibile) individuano un unico prodotto. I casi multipli restano `ambiguous`.

Lo scheduler non è attivo. `supabase-market-watch-scheduler.example.sql` contiene soltanto un esempio commentato: invoca un gate orario che procede esclusivamente alle 03:00 `Europe/Rome`, gestendo automaticamente ora solare e legale. Attivarlo solo dopo migration, secrets, deploy e collaudo manuale.

Eseguire i test core con `npm run test:market` prima del deploy.
