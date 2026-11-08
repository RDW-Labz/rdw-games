// In-app feedback submission — shared by the bidder and staff apps.
//
// Both apps show the same two-chip form (bug / idea) and write to the same
// `app_feedback` table (migration 0317). What differs is only the chrome, so
// the part worth sharing is this: the diagnostics snapshot and the insert.
//
// WHY THE DIAGNOSTICS ARE COLLECTED, NOT ASKED. The two version-guard
// incidents (#248, #249) both burned days on "which bundle is that device
// actually running?" — a question no tester can answer and every bug report
// needs. `collectDiagnostics()` reads it off the device so the reporter only
// has to describe the problem.
//
// Failure posture: the insert surfaces its error to the caller rather than
// swallowing it. A feedback form that silently drops reports is worse than no
// form, because the reporter believes they've been heard.

import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';

import { supabase } from './client';

/** Which binary the report came from. Matches the `app` CHECK in 0317. */
export type FeedbackApp = 'bidder' | 'staff';

/** 'bug' = something is broken; 'idea' = a recommendation. */
export type FeedbackKind = 'bug' | 'idea';

/** Server-enforced floor (0317 CHECK). Mirrored client-side for the button. */
export const FEEDBACK_MIN_LENGTH = 10;

export interface FeedbackDiagnostics {
  app_version: string | null;
  update_id: string | null;
  platform: string | null;
  os_version: string | null;
  device_model: string | null;
}

/** One uploaded screenshot or screen recording (mig 0325). */
export interface FeedbackAttachment {
  /** Object path inside the feedback-attachments bucket, uid-folder included. */
  path: string;
  content_type: string;
  bytes: number;
}

export interface SubmitFeedbackInput {
  app: FeedbackApp;
  kind: FeedbackKind;
  message: string;
  /** Route the reporter was on when they opened the form, e.g. '/lotting/quick'. */
  screen?: string | null;
  /**
   * Human name of the person filing, when the signed-in account isn't them.
   * The staff app signs in per *device* as a shared station account and
   * identifies the worker by PIN, so without this a report says which iPhone
   * it came from and not which tester. Bidder submissions leave it unset.
   */
  reporterLabel?: string | null;
  /**
   * Already-uploaded evidence. The upload happens before submit, in the app,
   * because a 40 MB screen recording must not be held in memory while somebody
   * finishes typing — and because a failed upload should be recoverable
   * without losing the words they already wrote.
   */
  attachments?: FeedbackAttachment[];
}

export type SubmitFeedbackResult =
  | { ok: true; id: string }
  | { ok: false; reason: string };

/**
 * Snapshot of the running bundle + device.
 *
 * `update_id` is 'embedded' on a build that has never applied an OTA — the
 * same label the profile screen's update row uses, so a report and a
 * screenshot of that row describe the bundle identically.
 */
export function collectDiagnostics(): FeedbackDiagnostics {
  return {
    app_version: Constants.expoConfig?.version ?? null,
    update_id: Updates.updateId ?? 'embedded',
    platform: Platform.OS,
    // Device.osVersion is null on some Android OEM builds; Platform.Version is
    // always populated, so it's the fallback rather than a second null source.
    os_version: Device.osVersion ?? (Platform.Version ? String(Platform.Version) : null),
    device_model: Device.modelName ?? null,
  };
}

/**
 * Insert one feedback row as the signed-in user.
 *
 * `author_id` is set from the live session rather than passed in: the RLS
 * insert policy checks `author_id = auth.uid()`, so anything else would be
 * rejected at the database anyway, and reading it here keeps callers from
 * having to thread a user id through their form state.
 *
 * `operator_id` is resolved for staff submissions only (bidders are
 * platform-wide identities, not scoped to one operator — see 0317).
 */
export async function submitFeedback(
  input: SubmitFeedbackInput,
): Promise<SubmitFeedbackResult> {
  const message = input.message.trim();
  if (message.length < FEEDBACK_MIN_LENGTH) {
    return { ok: false, reason: 'Please add a little more detail.' };
  }

  const { data: u, error: authErr } = await supabase.auth.getUser();
  if (authErr || !u?.user) {
    return { ok: false, reason: 'Your session expired — sign in and try again.' };
  }

  let operatorId: string | null = null;
  if (input.app === 'staff') {
    const { data: staff } = await supabase
      .from('operator_users')
      .select('operator_id')
      .eq('user_id', u.user.id)
      .maybeSingle();
    operatorId = (staff as { operator_id?: string } | null)?.operator_id ?? null;
  }

  // app_feedback postdates the last generated database.types.ts, so the row is
  // built untyped here. Column names are pinned by the migration and by
  // packages/db/migrations/0317_app_feedback.sql's CHECK constraints.
  const row = {
    author_id: u.user.id,
    app: input.app,
    kind: input.kind,
    message,
    screen: input.screen ?? null,
    reporter_label: input.reporterLabel?.trim() || null,
    operator_id: operatorId,
    // 0325 caps this at 6 in a CHECK; slicing here turns a would-be constraint
    // violation (which loses the whole report) into a quietly trimmed list.
    attachments: (input.attachments ?? []).slice(0, 6),
    ...collectDiagnostics(),
  };

  const { data, error } = await supabase
    .from('app_feedback')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .insert(row as any)
    .select('id')
    .single();

  if (error) return { ok: false, reason: error.message };
  return { ok: true, id: (data as { id: string }).id };
}

// ── THE LOOP BACK ────────────────────────────────────────────────────────────
//
// A report the reporter never hears about again teaches them not to file the
// next one. Twenty staff reports sat at status 'new' for ten days while most
// of them were quietly fixed and shipped — from the floor, that is
// indistinguishable from nobody reading them.
//
// So the reporter sees their own reports back, with the triage status and
// whatever note the manager left. `listMyReports` is the read half; the badge
// on the home screen is the nudge.

/** Mirrors the CHECK in 0317 and STATUSES in operator-web's triage action. */
export type FeedbackStatus = 'new' | 'triaged' | 'planned' | 'fixed' | 'wont_fix';

export interface FeedbackReport {
  id: string;
  created_at: string;
  kind: FeedbackKind;
  message: string;
  status: FeedbackStatus;
  triage_note: string | null;
  resolved_at: string | null;
}

/** What each status says to the person who filed it — not to the triager.
 *  'wont_fix' is deliberately not the phrase shown: it is accurate and it
 *  reads as a slap, and someone who files a good report that we decline still
 *  has to want to file the next one. */
export const FEEDBACK_STATUS_LABEL: Record<FeedbackStatus, string> = {
  new: 'Received',
  triaged: 'Looking at it',
  planned: 'On the list',
  fixed: 'Fixed',
  wont_fix: 'Not changing this',
};

/**
 * The reports this person filed.
 *
 * Matched on `reporter_label`, NOT author_id. The staff app signs in once per
 * DEVICE as a shared station account, so author_id is the iPhone on the
 * packing bench — filtering by it would show a picker every report anyone had
 * ever filed from that handset. The clocked-in worker's name is the only
 * thing that identifies the human, which is exactly why submitFeedback writes
 * it.
 *
 * Consequence worth knowing: two workers with the same display name would see
 * each other's reports. Nothing here is sensitive (they are bug reports about
 * the app, visible to all staff by RLS anyway), and the alternative — no
 * history at all — is what we are fixing.
 *
 * Returns [] rather than throwing. This decorates a form that must keep
 * working when the query does not.
 */
export async function listMyReports(
  reporterLabel: string | null | undefined,
  limit = 20,
): Promise<FeedbackReport[]> {
  const label = reporterLabel?.trim();
  if (!label) return [];

  const { data, error } = await supabase
    .from('app_feedback')
    .select('id, created_at, kind, message, status, triage_note, resolved_at')
    .eq('app', 'staff')
    .eq('reporter_label', label)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return [];
  return (data ?? []) as unknown as FeedbackReport[];
}

/**
 * Reports that were resolved since the reporter last looked.
 *
 * `since` is an ISO timestamp the app stores locally per worker. Null means
 * they have never opened the list, in which case everything already resolved
 * counts as unseen — which is the correct first run: those are precisely the
 * fixes nobody ever told them about.
 */
export function unseenResolved(
  reports: FeedbackReport[],
  since: string | null,
): FeedbackReport[] {
  return reports.filter((r) => {
    if (!r.resolved_at) return false;
    if (!since) return true;
    return r.resolved_at > since;
  });
}
