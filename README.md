# F.P.T Cards

PWA mobile per registrare e confermare i prestiti di carte tra i membri del team.

## Avvio locale

La service worker richiede un server HTTP. Con Python installato:

```powershell
python -m http.server 8080
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

Senza configurazione Supabase l'app continua a funzionare in modalità locale.
