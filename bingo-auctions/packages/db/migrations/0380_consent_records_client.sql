-- 0380 — record_operator_consent records the client (user agent and IP).
--
-- Every seller-policy acceptance on prod had a blank user_agent and ip_address
-- (0 of 267 on 2026-09-29): the function read per-header settings that the
-- current PostgREST no longer sets. It now reads request.headers (json), with
-- the old names as a fallback. Nothing else changes; the rest is the prod
-- definition (2026-09-29) verbatim. Grants are unchanged by CREATE OR REPLACE.
--
-- Rollback: re-create the previous body (the prod definition this replaces).

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.record_operator_consent(p_operator_id uuid, p_version integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_ip      TEXT;
  v_ua      TEXT;
  v_id      UUID;
  v_published BOOLEAN;
  v_headers JSON;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'record_operator_consent: caller is not authenticated';
  END IF;

  -- Audit F-04: only accept consent for PUBLISHED policy versions. A bidder
  -- calling the RPC directly with a draft version would have no real terms
  -- to consent to. A backdated published-after-consent flow is also blocked.
  SELECT published INTO v_published
    FROM operator_policies
   WHERE operator_id = p_operator_id AND version = p_version;

  IF v_published IS NULL THEN
    RAISE EXCEPTION 'record_operator_consent: policy version not found'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_published IS NOT TRUE THEN
    RAISE EXCEPTION 'record_operator_consent: policy version not published'
      USING ERRCODE = 'P0001';
  END IF;

  -- 0380: PostgREST passes request headers as ONE json setting,
  -- request.headers. The per-header settings read here before
  -- (request.headers.user-agent, .x-forwarded-for) are the old format and are
  -- never set, so all 267 acceptances on prod had neither. Read the json first
  -- and keep the old names as a fallback. x-forwarded-for can hold a chain;
  -- the first address is the client's.
  BEGIN
    v_headers := nullif(current_setting('request.headers', true), '')::json;
  EXCEPTION WHEN OTHERS THEN v_headers := NULL; END;
  BEGIN
    v_ip := coalesce(
      nullif(btrim(split_part(v_headers ->> 'x-forwarded-for', ',', 1)), ''),
      v_headers ->> 'cf-connecting-ip',
      nullif(current_setting('request.headers.x-forwarded-for', true), ''));
  EXCEPTION WHEN OTHERS THEN v_ip := NULL; END;
  BEGIN
    v_ua := coalesce(
      nullif(v_headers ->> 'user-agent', ''),
      nullif(current_setting('request.headers.user-agent', true), ''));
  EXCEPTION WHEN OTHERS THEN v_ua := NULL; END;

  INSERT INTO operator_policy_acceptances (user_id, operator_id, version, ip_address, user_agent)
  VALUES (v_user_id, p_operator_id, p_version, v_ip, v_ua)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;
