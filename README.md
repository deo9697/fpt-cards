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

Fast Scan usa `getUserMedia` e richiede HTTPS (oppure localhost). Il motore Tesseract.js viene caricato soltanto quando si avvia lo scanner; la prima preparazione richiede connessione, mentre le risorse già scaricate vengono conservate nella cache OCR della PWA. Il buffer non salvato è persistito in IndexedDB e può essere ripreso dopo refresh o crash.

Per misurare Fast Scan sul dispositivo senza telemetria esterna, eseguire nella console `localStorage.setItem('fpt-fast-scan-debug','1')` e ricaricare. Le metriche locali sono disponibili con `window.__fastScanPerf.snapshot()`; per disattivarle usare `localStorage.removeItem('fpt-fast-scan-debug')`.

Su Vercel gli endpoint equivalenti sono `/api/push-public-key` e `/api/send-push`. Le stesse variabili d'ambiente devono essere configurate nel progetto Vercel.

## Web Push su Netlify

Variabili richieste: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `PUSH_WEBHOOK_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

Generare le chiavi localmente eseguendo `powershell -ExecutionPolicy Bypass -File scripts/generate-vapid.ps1`, quindi copiarle direttamente nelle variabili Netlify senza inserirle nel repository.

Creare inoltre un Database Webhook Supabase per INSERT e UPDATE su `public.loans`, diretto a `https://DOMINIO/.netlify/functions/send-push`, con header `x-webhook-secret` uguale a `PUSH_WEBHOOK_SECRET`.

Senza configurazione Supabase l'app continua a funzionare in modalità locale.
