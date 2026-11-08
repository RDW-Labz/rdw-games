-- Runs on a fresh copy (seed [+ 0453] + conc-fns.sql) after the concurrent
-- run's rig_calls were copied into rig_src. Replays them one at a time, each in
-- its own transaction (like real RPCs), in the order they serialized on the
-- lot's advisory lock, then counts calls whose result differs.
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
SELECT format('SELECT rig_bid(%L, %s, %s, %s, %s)', lot_id, bidder_n, amount, coalesce(qty::text, 'NULL'), nargs)
  FROM rig_src ORDER BY seq \gexec
SELECT 'REPLAY calls=' || (SELECT count(*) FROM rig_src) || ' differing=' || count(*)
       || ' first_differing_seq=' || coalesce(min(seq)::text, '-')
  FROM (SELECT s.seq FROM rig_src s JOIN rig_calls c USING (seq)
         WHERE (s.lot_id, s.bidder_n, s.amount, s.ok, s.reason, s.cur, s.leader, s.ext, s.outbid)
               IS DISTINCT FROM (c.lot_id, c.bidder_n, c.amount, c.ok, c.reason, c.cur, c.leader, c.ext, c.outbid)) d;
