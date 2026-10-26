#!/usr/bin/env bash
# Applies migrations one by one on a throwaway local D1 with seed data between them, then checks
# row counts and foreign keys survive. Run before deploying any migration that rebuilds tables.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=".tmp/migtest-$(date +%s)"
mkdir -p "$DIR"
run() { npx wrangler d1 execute share-db --local --persist-to "$DIR" "$@" >/dev/null; }
q() { npx wrangler d1 execute share-db --local --persist-to "$DIR" --json --command "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s)[0].results)))'; }

run --file migrations/0001_init.sql
run --file scripts/migration-seed.sql
before=$(q "SELECT (SELECT count(*) FROM bills) b, (SELECT count(*) FROM bill_shares) s")
for f in $(ls migrations/*.sql | sort | tail -n +2); do run --file "$f"; done
after=$(q "SELECT (SELECT count(*) FROM bills) b, (SELECT count(*) FROM bill_shares) s")
payers=$(q "SELECT count(*) n FROM bill_payers")
fk=$(q "PRAGMA foreign_key_check")
echo "before: $before"
echo "after:  $after"
echo "payers: $payers"
echo "fk:     $fk"
[ "$before" = "$after" ] && [ "$fk" = "[]" ] && echo "✔ migration preserves data" || { echo "✘ migration changed data"; exit 1; }
