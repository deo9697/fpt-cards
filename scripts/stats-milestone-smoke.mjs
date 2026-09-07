import assert from 'node:assert/strict';
import fs from 'node:fs';

const sql = fs.readFileSync(new URL('../supabase-milestone-6-statistics-progression.sql', import.meta.url), 'utf8');
for (const required of [
  'create table public.matches',
  'create table public.member_progression',
  'create table public.xp_transactions',
  "unique (member_slug, source_type, source_id)",
  'create or replace function public.register_match',
  'create or replace function public.get_my_progression',
  'create or replace function public.get_stats',
  'create or replace function public.get_team_stats',
  'create or replace function public.delete_match',
  'create or replace function public.level_from_xp',
  "if not exists(select 1 from public.decks where id = p_deck_id and owner_slug = me and game = p_game)",
  "base_xp := 10 + case p_result when 'win' then 5 when 'draw' then 2 else 0 end",
  'awarded := least(base_xp, greatest(0, 100 - already_today))',
  'delete from public.xp_transactions where member_slug = me and source_type',
  'grant execute on function public.register_match'
]) assert(sql.includes(required), `Migration statistiche/progression incompleta: ${required}`);
assert(sql.includes('to anon, authenticated'), 'grant RPC statistiche non segue la regola anon+authenticated di questo progetto');
assert(!/grant execute[^;]*to authenticated;/.test(sql), 'una grant authenticated-only romperebbe queste RPC (schema custom p_token, stesso client anon-key sempre)');
const progressionBody = sql.slice(sql.indexOf('create or replace function public.get_my_progression'), sql.indexOf('create or replace function public.get_stats'));
assert(!/declare[^;]*\blevel\s+integer\b/.test(progressionBody), 'get_my_progression dichiara di nuovo una variabile locale "level": collide col nome della colonna member_progression.level e Postgres la rifiuta con "column reference \'level\' is ambiguous" (bug reale già capitato una volta, non re-introdurlo)');
assert(progressionBody.includes('member_level'), 'get_my_progression deve usare un nome di variabile diverso dalla colonna (member_level), non "level"');
console.log('PASS migrazione SQL: tabelle, unique anti-duplicato, validazione mazzo/gioco, cap giornaliero, reversal delete_match, grant anon+authenticated, nessuna variabile "level" ambigua');

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { StatsController } = await import('../js/stats.js');

const decks = [
  { id:'deck-ryzeal', game:'yugioh', name:'Ryzeal' },
  { id:'deck-labrynth', game:'yugioh', name:'Labrynth' },
  { id:'deck-op-luffy', game:'onepiece', name:'Luffy' }
];
function makeApi(overrides = {}) {
  return {
    progression: async () => ({ totalXp:2640, level:12, xpToday:30, dailyCap:100 }),
    stats: async (game, { deckId, period } = {}) => {
      overrides.lastStatsCall = { game, deckId, period };
      return [
        { deck_id:'deck-ryzeal', deck_name:'Ryzeal', matches:24, wins:18, losses:5, draws:1, win_rate:75 },
        { deck_id:'deck-labrynth', deck_name:'Labrynth', matches:11, wins:7, losses:4, draws:0, win_rate:63.6 }
      ];
    },
    teamStats: async (game, { period } = {}) => {
      overrides.lastTeamStatsCall = { game, period };
      return [
        { member_slug:'daniele', member_name:'Daniele', deck_id:'deck-ryzeal', deck_name:'Ryzeal', matches:24, wins:18, losses:5, draws:1, win_rate:75 },
        { member_slug:'marco', member_name:'Marco', deck_id:'deck-labrynth', deck_name:'Labrynth', matches:9, wins:4, losses:5, draws:0, win_rate:44.4 }
      ];
    },
    registerMatch: async payload => { overrides.lastRegister = payload; return { match:{ id:'match-1' }, xpAwarded:15, totalXp:2655, level:12, levelUp:false }; }
  };
}

const state = { game:'yugioh', currentUser:'daniele', decks };
const calls = {};
const stats = new StatsController({ api:makeApi(calls), getState:() => state, onRender:() => {}, onToast:() => {} });
await stats.load();
assert.equal(stats.progression.totalXp, 2640);
assert.equal(stats.myRows.length, 2);
assert.equal(stats.totals.matches, 35, 'i totali Io devono sommare tutti i mazzi visibili');
assert.equal(stats.decks.length, 2, 'il modal di registrazione deve vedere solo i mazzi del gioco corrente (yugioh), non One Piece');
assert(!stats.decks.some(deck => deck.id === 'deck-op-luffy'), 'un mazzo di un altro gioco non deve comparire nel selettore match');
console.log('PASS StatsController.load: progression + stats "Io", totali corretti, mazzi filtrati per gioco corrente');

stats.setDeckFilter('deck-ryzeal');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(calls.lastStatsCall.deckId, 'deck-ryzeal', 'il filtro mazzo deve passare deckId alla RPC get_stats');
stats.setPeriodFilter('7d');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(calls.lastStatsCall.period, '7d', 'il filtro periodo deve passare period alla RPC');
console.log('PASS filtri mazzo/periodo propagati alla RPC get_stats');

stats.setScope('team');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(stats.teamRows.length, 2);
assert.equal(stats.visibleRows.length, 2, 'senza filtro membro, la vista team mostra tutte le righe');
stats.setMemberFilter('daniele');
assert.equal(stats.visibleRows.length, 1, 'il filtro membro nella vista team è applicato client-side sul risultato già caricato');
assert.equal(stats.visibleRows[0].memberSlug, 'daniele');
console.log('PASS scope Team: righe per membro, filtro membro client-side');

const html = stats.view();
assert(html.includes('Ryzeal') || html.includes('Daniele'), 'la vista non renderizza le righe attese');
assert(!/undefined|NaN/.test(html), 'la vista statistiche produce valori non definiti');
console.log('PASS view() non produce undefined/NaN');

stats.openMatchDialog();
stats.setMatchDeck('deck-ryzeal');
stats.setMatchResult('win');
await stats.registerMatch();
assert.equal(calls.lastRegister.game, 'yugioh');
assert.equal(calls.lastRegister.deckId, 'deck-ryzeal');
assert.equal(calls.lastRegister.result, 'win');
assert.equal(stats.lastResult.xpAwarded, 15);
assert.equal(stats.progression.totalXp, 2655, 'la progressione in memoria si aggiorna subito dalla risposta di register_match, senza richiesta extra');
const feedbackHtml = stats.view();
assert(feedbackHtml.includes('+15 XP'));
assert(!feedbackHtml.includes('Limite giornaliero'), 'un match non cappato non deve mostrare il messaggio di limite giornaliero');
console.log('PASS registrazione match: payload corretto, feedback XP mostrato, progression aggiornata senza fetch aggiuntiva');

const cappedApi = makeApi(calls);
cappedApi.registerMatch = async payload => { calls.lastRegister = payload; return { match:{ id:'match-2' }, xpAwarded:0, totalXp:2655, level:12, levelUp:false }; };
const cappedStats = new StatsController({ api:cappedApi, getState:() => state, onRender:() => {}, onToast:() => {} });
await cappedStats.load();
cappedStats.openMatchDialog();
cappedStats.setMatchDeck('deck-ryzeal');
cappedStats.setMatchResult('win');
await cappedStats.registerMatch();
const cappedHtml = cappedStats.view();
assert(cappedHtml.includes('+0 XP'), 'un match cappato deve comunque mostrare +0 XP');
assert(cappedHtml.includes('Limite giornaliero raggiunto'), 'un match il cui XP è stato azzerato dal cap giornaliero deve avvisare l\'utente, non mostrare solo "+0 XP" senza spiegazione');
console.log('PASS cap giornaliero: XP azzerato dalla RPC mostra il messaggio "Limite giornaliero raggiunto"');
