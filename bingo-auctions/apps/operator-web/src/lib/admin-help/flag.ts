// Admin Help kill switch (#878/#879/#880). Fail closed unless env is "true".
// Staff Help is denied even when the station operator_users row is admin.

export type AdminHelpSurface = 'admin_console' | 'staff_help';
export type AdminHelpCaller = { surface: AdminHelpSurface; role: string };

export type AdminHelpEnv = Record<string, string | undefined>;

export function isAdminHelpEnabled(env: AdminHelpEnv = process.env): boolean {
  return env.ADMIN_HELP_ENABLED === 'true';
}

export function authorizeAdminHelpRead(
  caller: AdminHelpCaller,
  env: AdminHelpEnv = process.env,
): 'disabled' | 'denied' | null {
  if (!isAdminHelpEnabled(env)) return 'disabled';
  if (caller.surface !== 'admin_console' || caller.role !== 'admin') return 'denied';
  return null;
}
