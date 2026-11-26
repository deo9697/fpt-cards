#!/bin/bash
# Backup FPT Cards prima della pulizia dello storico prezzi (2026-11-26).
B="/c/Users/ASUS/Desktop/PROGETTONI WOWOWOW/backup-supabase-2026-11-26"
cd "/c/Users/ASUS/Desktop/PROGETTONI WOWOWOW/applicazione gestione carte yougioh" && export PATH="/c/Program Files/nodejs:$PATH"
q(){ timeout 600 npx supabase db query --remote --read-only "$1" 2>/dev/null; }
count(){ q "$1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d.slice(d.indexOf('{')));console.log(j.rows[0].n)})"; }
export_chunk(){ # name table where
  local name=$1 table=$2 where=$3 tries=0
  while [ $tries -lt 3 ]; do
    q "select * from $table where $where order by 1" > "$B/_tmp.json"
    local got; got=$(node "$B/compact.cjs" "$B/_tmp.json" "$B/$name.ndjson.gz" 2>&1)
    local want; want=$(count "select count(*) n from $table where $where")
    if [ "$got" = "$want" ]; then echo "OK $name $got"; rm -f "$B/_tmp.json"; return 0; fi
    echo "RETRY $name got=$got want=$want"; tries=$((tries+1))
  done
  echo "FAIL $name"; return 1
}
set -o pipefail
d=2026-08-24
while [[ "$d" < "2026-12-01" ]]; do
  n=$(date -d "$d + 7 days" +%F)
  export_chunk "snapshots_$d" market_price_snapshots "captured_at >= '$d' and captured_at < '$n'" || exit 1
  d=$n
done
export_chunk snapshots_outside market_price_snapshots "captured_at < '2026-08-24' or captured_at >= '2026-12-01' or captured_at is null" || exit 1
for m in 2026-09 2026-10 2026-11; do
  export_chunk "events_$m" market_price_events "detected_at >= '$m-01' and detected_at < ('$m-01'::date + interval '1 month')" || exit 1
done
export_chunk events_outside market_price_events "detected_at < '2026-09-01' or detected_at >= '2026-12-01' or detected_at is null" || exit 1
export_chunk current_price_snapshots market_current_price_snapshots "true" || exit 1
total=$(count "select count(*) n from market_price_snapshots")
echo "TOTAL_DB_SNAPSHOTS $total"
echo BACKUP_DONE
