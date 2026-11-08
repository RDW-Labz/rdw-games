conc() {
  lab=$1; mode=$2; shift 2
  clone c453run s453base; [ $mode = post ] && P -d c453run -f $MIG; P -d c453run -f /w453/conc-fns.sql
  for f in "$@"; do pgbench -n -U postgres -c 16 -j 16 -t 40 -f /w453/$f c453run 2>&1 | grep -E 'failed transactions' | sed "s/^/  $f: /"; done
  P -d c453run -c "\copy rig_calls to /tmp/rig_calls.csv csv"
  clone c453rep s453base; [ $mode = post ] && P -d c453rep -f $MIG; P -d c453rep -f /w453/conc-fns.sql
  P -d c453rep -c "CREATE TABLE rig_src (LIKE rig_calls)" -c "\copy rig_src from /tmp/rig_calls.csv csv"
  rep=$(P -d c453rep -f /w453/replay.sql 2>&1 | grep '^REPLAY')
  psql -U postgres -At -d c453run -f /w453/dump-conc-state.sql > /tmp/conc_run.txt 2>&1
  inv=$(grep '^INV' /tmp/conc_run.txt | grep -c false)
  drops=$(grep '^PRICE_DROPS' /tmp/conc_run.txt | tr '\n' ' ')
  calls=$(P -d c453run -c "select count(*) || ' calls, ' || count(*) filter (where ok) || ' ok, reasons ' || string_agg(distinct reason, ',') from rig_calls")
  echo "$lab: $calls | $rep | $drops| invariant failures=$inv"
  grep '^LOT' /tmp/conc_run.txt | sed 's/^/    /'
  [ $inv -eq 0 ] || { bad "$lab invariants"; grep '^INV' /tmp/conc_run.txt; }
}
