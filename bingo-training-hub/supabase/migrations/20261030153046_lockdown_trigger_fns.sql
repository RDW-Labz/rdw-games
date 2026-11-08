/*
# BinGo Training Hub — Lock down trigger functions
Revoke EXECUTE on trigger-only SECURITY DEFINER functions (handle_new_user,
recompute_qualified) so they cannot be called directly via the Data API.
The privileged action functions (sign_off_practical, require_retraining,
update_employee_profile) remain callable by authenticated because they
perform their own manager authorization checks internally.
*/

REVOKE EXECUTE ON FUNCTION handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION recompute_qualified() FROM PUBLIC, anon, authenticated;
