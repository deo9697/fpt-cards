// Autenticazione dei webhook DB → Vercel (trigger `fpt-web-push`, `notification-push`).
// Il file inizia con "_": Vercel non lo espone come endpoint.
//
// Rotazione senza downtime: oltre a PUSH_WEBHOOK_SECRET è accettato PUSH_WEBHOOK_SECRET_NEXT.
//   1) imposta PUSH_WEBHOOK_SECRET_NEXT = nuovo valore e fai il deploy (i due secret valgono);
//   2) aggiorna i trigger DB al nuovo valore (supabase/manual/rotate-push-webhook-secret.sql);
//   3) promuovi: PUSH_WEBHOOK_SECRET = nuovo valore, rimuovi PUSH_WEBHOOK_SECRET_NEXT, nuovo deploy → il vecchio è invalidato.
// Il confronto è a tempo costante (digest sha256 + timingSafeEqual). Nessun valore viene mai loggato.
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = value => createHash('sha256').update(String(value)).digest();

export function webhookAuthorized(req, env = process.env) {
  const provided = req?.headers?.['x-webhook-secret'];
  if (typeof provided !== 'string' || !provided) return false;
  const candidates = [env.PUSH_WEBHOOK_SECRET, env.PUSH_WEBHOOK_SECRET_NEXT].filter(value => typeof value === 'string' && value.length >= 16);
  const given = digest(provided);
  // Nessun cortocircuito: si confrontano sempre tutti i candidati.
  return candidates.reduce((ok, candidate) => timingSafeEqual(given, digest(candidate)) || ok, false);
}
