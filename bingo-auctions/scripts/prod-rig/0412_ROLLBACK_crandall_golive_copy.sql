-- Rollback for 0412_crandall_golive_copy.sql — standby only.
-- Restores Crandall's pickup_hours / pickup_instructions / customer_notice to
-- exactly what prod held on 2026-10-13 before 0412 (read 12:50 CT).
BEGIN;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.warehouses WHERE id = 'a6cc2d66-f6ba-4923-acb1-81fd3855ea06') THEN
    RAISE NOTICE 'Crandall warehouse not here, skipping';
    RETURN;
  END IF;
  UPDATE public.warehouses
     SET pickup_hours        = $h${"sat":[{"open":"09:00","close":"16:00"}],"sun":[{"open":"09:00","close":"16:00"}]}$h$::jsonb,
         pickup_instructions = $i$PICKUP LOCATION:

119 E. Crandall Ave.
Harrison, AR 72601
Located above Cause for Paws

⚠️ SELF-SERVICE PICKUP ONLY

This is a self-service pickup location. There will be no staff on-site to assist with loading. Please come prepared with enough help and the proper equipment to load and transport your items yourself.$i$,
         customer_notice     = $n$⚠️ SPECIAL AUCTION – OFF-SITE PICKUP LOCATION

Pickup Address:
119 E. Crandall Ave.
Harrison, AR 72601
Located above Cause for Paws

PLEASE NOTE: This is a special auction with an off-site pickup location.$n$,
         updated_at          = now()
   WHERE id = 'a6cc2d66-f6ba-4923-acb1-81fd3855ea06';
END
$do$;

COMMIT;
