# Fast Scan — piano di collaudo reale

Eseguire il collaudo su uno smartphone reale, in luce diffusa, con una sessione nuova e PaddleOCR già caricato. Il campione minimo è di 40 carte:

| Gruppo | Carte | Lingua | Protezione | Zoom |
| --- | ---: | --- | --- | --- |
| Set moderni | 10 | 5 IT, 5 EN | 5 sleeve, 5 nude | 1× |
| Set storici | 10 | 5 IT, 5 EN | 5 sleeve, 5 nude | 1× |
| Codici con `0/O`, `1/I`, `5/S`, `8/B`, `2/Z`, `6/G` | 12 | IT/EN miste | miste | 1× e 1,5× |
| Stessa printing consecutiva | 4 copie | qualsiasi | uguale | 1× |
| Condizioni difficili controllate | 4 | qualsiasi | 2 sleeve lucide | 1× e 1,5× |

Per ogni scatto annotare:

| # | Set code atteso | Raw OCR (debug) | Esito | Classe | Tempo (s) | Note |
| ---: | --- | --- | --- | --- | ---: | --- |
| 1–40 |  |  | add / review / fail | exact / near / ambiguous / reject |  |  |

Metriche finali:

- exact auto-add / 40;
- near auto-add / 40;
- review / 40;
- fail / 40;
- false-positive / 40 (target: 0);
- tempo medio tra pressione di “Scatta e analizza” e feedback;
- verifica che ogni pressione aggiunga al massimo una copia;
- verifica che quattro copie consecutive della stessa printing producano quantità `4`;
- verifica manuale a 360×800, 390×844 e 412×915: nessun overflow, ROI nitida, CTA visibile e tre azioni su una riga.

La diagnostica separata si abilita solo aggiungendo `?debugScan=1` all'URL prima dell'hash. I dettagli vengono scritti nella console e non compaiono nella UI di produzione.
