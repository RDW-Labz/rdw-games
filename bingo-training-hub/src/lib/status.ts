import type { EmployeeTrainingRow } from './types';

export type TrainingStatus = 'not_started' | 'failed' | 'acknowledge' | 'signoff' | 'qualified' | 'retrain';

export interface StatusMeta {
  label: string;
  short: string;
  color: string; // tile colour
  ink: string; // text colour on paper
  glyph: 'empty' | 'x' | 'pen' | 'eye' | 'check' | 'loop';
  next: string; // what happens next, in plain words
}

export const STATUS: Record<TrainingStatus, StatusMeta> = {
  not_started: { label: 'Not started', short: 'To do', color: '#b9b2a6', ink: '#636363', glyph: 'empty', next: 'Open the lesson and take the quiz.' },
  failed: { label: 'Retake quiz', short: 'Retake', color: '#c8382f', ink: '#a52d25', glyph: 'x', next: 'Review the lesson, then retake the quiz.' },
  acknowledge: { label: 'Sign to confirm', short: 'Sign', color: '#ec633d', ink: '#b8441f', glyph: 'pen', next: 'Sign that you read and understood it.' },
  signoff: { label: 'Awaiting sign-off', short: 'Sign-off', color: '#20386c', ink: '#20386c', glyph: 'eye', next: 'A manager watches you do it, then signs off.' },
  qualified: { label: 'Qualified', short: 'Done', color: '#5a7d4a', ink: '#3f5a35', glyph: 'check', next: 'You are qualified on this task.' },
  retrain: { label: 'Retrain', short: 'Retrain', color: '#ec633d', ink: '#b8441f', glyph: 'loop', next: 'This procedure changed. Take it again.' },
};

export function statusOf(r: Pick<EmployeeTrainingRow, 'retraining_required' | 'qualified' | 'requires_practical' | 'quiz_passed' | 'acknowledged' | 'practical_signed_off' | 'quiz_total' | 'completed_version'>): TrainingStatus {
  if (r.retraining_required && r.completed_version > 0) return 'retrain';
  if (r.qualified) return 'qualified';
  if (r.quiz_passed && !r.acknowledged) return 'acknowledge';
  if (r.requires_practical && r.quiz_passed && r.acknowledged && !r.practical_signed_off) return 'signoff';
  if (r.quiz_total > 0 && !r.quiz_passed) return 'failed';
  return 'not_started';
}

export const isDone = (r: EmployeeTrainingRow) => statusOf(r) === 'qualified';

export function isOverdue(r: EmployeeTrainingRow) {
  if (!r.due_date || isDone(r)) return false;
  return new Date(r.due_date + 'T23:59:59') < new Date();
}

export function dueLabel(due: string | null) {
  if (!due) return null;
  const d = new Date(due + 'T12:00:00');
  const days = Math.round((d.getTime() - Date.now()) / 86400000);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (days < 0) return { text: `Late · ${date}`, tone: 'late' as const };
  if (days === 0) return { text: 'Due today', tone: 'soon' as const };
  if (days <= 3) return { text: `Due in ${days}d`, tone: 'soon' as const };
  return { text: `Due ${date}`, tone: 'later' as const };
}

export function pct(n: number, d: number) {
  return d ? Math.round((n / d) * 100) : 0;
}
