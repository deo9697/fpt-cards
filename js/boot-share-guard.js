// Guard di bootstrap immediato per i link di raccolta condivisa: marca
// subito la pagina come "share" (prima ancora che app.js — un modulo grande —
// venga scaricato/eseguito), così qualunque regola CSS o controllo scritto su
// body[data-page] vede il confine pubblico/privato fin dal primissimo istante.
// Tocca solo l'attributo, mai il DOM di #app. In un file (non inline) per la
// Content-Security-Policy, che non ammette script inline (vercel.json).
if (/^#\/share\/[0-9a-f-]{36}$/i.test(location.hash)) document.body.dataset.page = 'share';
