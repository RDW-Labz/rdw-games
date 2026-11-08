SELECT (SELECT json_agg(x) FROM (SELECT o.slug, o.is_demo, o.default_buyer_premium_bps, o.application_fee_bps, o.membership_fee_bps, o.pro_enabled, o.pro_monthly_cents, o.auto_charge_grace_hours, o.pickup_grace_extension_hours, o.offers_shipping, o.offers_pickup, o.tax_mode, o.tax_rate_bps, o.subscription_tier FROM operators o) x) ops,
(SELECT json_agg(x) FROM (SELECT status::text s, count(*) n FROM invoices GROUP BY 1) x) inv_status,
(SELECT json_agg(x) FROM (SELECT buyer_premium_bps, count(*) n FROM auctions GROUP BY 1) x) auc_bp,
(SELECT json_agg(x) FROM (SELECT reason, count(*) n, sum(amount_cents) c, count(paid_at) paid FROM bidder_fee_ledger GROUP BY 1) x) fees,
(SELECT json_agg(x) FROM (SELECT fulfillment_method::text m, count(*) n FROM invoices GROUP BY 1) x) fulfil,
(SELECT json_agg(x) FROM (SELECT status::text s, count(*) n FROM bidder_subscriptions GROUP BY 1) x) subs,
(SELECT min(created_at) FROM invoices) first_invoice
