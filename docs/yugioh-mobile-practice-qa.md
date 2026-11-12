# Yu-Gi-Oh! — campo mobile, menu rapido e Testa mazzo

Data: 12 novembre 2026. Aggiorna le verifiche della prima arena del 10 novembre.

## Comportamento

- Su telefono l'arena richiede il formato orizzontale. Richiede il blocco reale dell'orientamento dove supportato; altrimenti un pannello blocca il campo e invita a ruotare il dispositivo. Il fullscreen viene richiesto soltanto durante un gesto dell'utente. Uscendo si rilasciano il blocco e l'eventuale fullscreen acquisito dall'arena.
- Toccare una propria carta apre un menu compatto. Dalla mano: Norm. Summon, Sp. Summon, Difesa e Set per i Mostri compatibili; Activate e Set per Magie/Trappole. La scelta evidenzia le destinazioni e non sposta la carta prima del tocco sulla casella. Le Magie Terreno usano la zona Terreno.
- Una pressione lunga di 320 ms consente di trascinare verso una zona e scegliere poi la giocata. Lo scorrimento della mano rimane disponibile prima della pressione lunga. Si può trascinare anche dall'Extra Deck e dalle altre gallerie consultabili. Il Side Deck resta in sola lettura.
- Sul terreno il menu permette Activate, posizione/scoperta/Set quando compatibili e Cimitero. Activate dichiara l'effetto nella catena condivisa; Risolvi rimuove l'ultimo anello. Costi, requisiti, timing ed effetti si applicano manualmente. Dettagli apre facoltativamente il pannello esteso.
- Draw, Standby, M1, BP, M2 ed End sono pulsanti diretti. Solo il giocatore di turno può cambiare fase o turno. La selezione della fase non pesca, risolve effetti o passa il turno. Rimangono Pesca, Fase successiva e Fine turno.
- Le carte mantengono le proporzioni e riempiono in modo coerente le zone ordinarie e le Zone Mostri Extra, anche in Difesa.
- In Altro, soltanto per Yu-Gi-Oh! e per i membri autorizzati, Testa mazzo permette di scegliere un proprio mazzo salvato. La preparazione legge il mazzo dal servizio; la partita di prova prosegue in memoria senza creare duelli, inviti, notifiche o risultati. Il campo avversario è passivo, senza IA; il suo turno viene saltato. Ricomincia test ripristina cinque carte iniziali e Uscita torna alla scelta del mazzo.
- Una nuova versione del tavolo invalida menu e destinazioni in sospeso. Le carte settate e il relativo registro mantengono privata l'identità fino alla scoperta/attivazione.
- Il polling aggiorna i riepiloghi della lobby senza ricreare il campo invariato: un aggiornamento della lista dei duelli non interrompe una pressione lunga. La lobby visibile continua ad aggiornarsi normalmente.

## Verifiche automatiche

Il comando `npm run test:yugioh-simulator` raccoglie motore, fasi, schema Postgres, servizio, controller, orientamento, gesti, prova in solitaria, menu al rilascio/al tocco, browser e navigazione dei due giochi.

Le verifiche usano mazzi e membri sintetici, store HTTP in memoria e Postgres PGlite. Non vengono creati tavoli, inviti o notifiche di produzione. La prova browser usa i moduli dell'applicazione e il servizio reali, due client Chrome indipendenti e input touch nativo tramite CDP.

Le verifiche di orientamento includono API mancanti, rifiutate, ritardate e bloccate; uscita durante le richieste; rientro e proprietà del fullscreen. Il collaudo desktop non dimostra il supporto al blocco fisico su ogni telefono: Safari/iOS e i browser che rifiutano il lock richiedono la rotazione manuale indicata dal pannello.

Esito finale: tutti i 13 script della suite superati. Il browser completo termina con `yugioh-duel-browser-smoke: OK`: tap e pressione lunga effettivi, annullamento e versioni superate, Mostri/Magie/Trappole, attivazioni e risoluzioni sincronizzate, Xyz, due Zone Extra occupate, LP, fasi dirette e sequenziali, controllo fuori turno, ripresa da URL e risultato condiviso. Eccezioni JavaScript, errori console, risorse mancanti e richieste esterne: zero.

Nei viewport 844×390, 932×430 e 740×360 il campo e tutti i comandi delle fasi sono raggiungibili, senza overflow orizzontale. L'artwork occupa circa il 92% dell'altezza della casella; quello delle Zone Extra ha la stessa altezza delle zone Mostri ordinarie entro il 5%. Le carte in Difesa restano contenute e le immagini usano `object-fit: contain`. Il blocco verticale impedisce sia Pesca sia il trascinamento.

## Evidenze visive locali

Le catture sono prodotte dallo smoke browser in `artifacts/yugioh-duel/` e non sono incluse nel codice pubblicato:

- `tap-actions.png`: tocco su Mostro nella mano, menu rapido e sei fasi sul telefono.
- `drag-active.png`: carta tenuta premuta con anteprima e casella evidenziata.
- `context-actions.png` e `context-extra.png`: scelta dopo il trascinamento, anche dall'Extra Deck.
- `rotate-phone.png` e `practice-rotate-phone.png`: blocco in verticale.
- `landscape.png`, `landscape-932.png`, `landscape-740.png`: partita di prova nei viewport 844×390, 932×430 e 740×360.
- `practice-picker.png` e `practice-landscape.png`: scelta dei propri mazzi e campo in solitaria.

Le immagini della prima verifica in verticale nel documento del 10 novembre descrivono la versione precedente e non il comportamento corrente.
