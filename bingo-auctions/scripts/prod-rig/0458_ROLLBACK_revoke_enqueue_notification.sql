-- ROLLBACK for 0458: restores the grants enqueue_notification had on prod
-- before 0458 (ACL 2026-10-26: postgres, anon, authenticated, service_role).
SET lock_timeout = '3s';
GRANT EXECUTE ON FUNCTION public.enqueue_notification(notification_kind, uuid, jsonb, text) TO anon;
GRANT EXECUTE ON FUNCTION public.enqueue_notification(notification_kind, uuid, jsonb, text) TO authenticated;
