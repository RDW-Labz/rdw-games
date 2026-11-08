/* One data API for the whole UI. Live mode talks to Supabase exactly like the
   original screens did; demo mode runs on an in-memory copy (see demo.ts). */
import { supabase, hasSupabase } from './supabase';
import { demo } from './demo';
import type { Assignment, AssignmentInput, Category, EmployeeTrainingRow, Lesson, LessonInput, LessonProgress, Profile } from './types';

export const isDemo = !hasSupabase || new URLSearchParams(window.location.search).has('demo');

function must<T>(r: { data: T | null; error: unknown }): T {
  if (r.error) throw r.error;
  return r.data as T;
}

export const api = {
  async profiles(): Promise<Profile[]> {
    if (isDemo) return demo.profiles();
    return must(await supabase.from('profiles').select('*').order('full_name')) ?? [];
  },
  async training(employeeId?: string): Promise<EmployeeTrainingRow[]> {
    if (isDemo) return demo.training(employeeId);
    let qb = supabase.from('employee_training').select('*');
    if (employeeId) qb = qb.eq('employee_id', employeeId);
    const rows: EmployeeTrainingRow[] = must(await qb.order('category_sort').order('lesson_sort')) ?? [];
    // One row per person + lesson, even when several assignments reach them.
    const seen = new Set<string>();
    return rows.filter((r) => (seen.has(r.employee_id + r.lesson_id) ? false : (seen.add(r.employee_id + r.lesson_id), true)));
  },
  async categories(): Promise<Category[]> {
    if (isDemo) return demo.categories();
    return must(await supabase.from('categories').select('*').order('sort_order')) ?? [];
  },
  async lessons(): Promise<Lesson[]> {
    if (isDemo) return demo.lessons();
    return must(await supabase.from('lessons').select('*').order('sort_order')) ?? [];
  },
  async lesson(id: string): Promise<Lesson | null> {
    if (isDemo) return demo.lesson(id);
    return must(await supabase.from('lessons').select('*').eq('id', id).maybeSingle());
  },
  async progress(lessonId: string, employeeId: string): Promise<LessonProgress | null> {
    if (isDemo) return demo.progress(lessonId, employeeId);
    return must(await supabase.from('lesson_progress').select('*').eq('lesson_id', lessonId).eq('employee_id', employeeId).maybeSingle());
  },
  async assignments(): Promise<Assignment[]> {
    if (isDemo) return demo.assignments();
    return must(await supabase.from('assignments').select('*')) ?? [];
  },

  /** Saves a quiz attempt. On a retake for a changed lesson the employee signs again. */
  async submitQuiz(o: { employeeId: string; lesson: Lesson; score: number; existing: LessonProgress | null; resetAck: boolean }): Promise<LessonProgress> {
    const total = o.lesson.quiz_questions.length;
    const passed = o.score >= o.lesson.passing_score;
    if (isDemo) return demo.submitQuiz(o.employeeId, o.lesson.id, o.score, total, passed, o.lesson.version, o.resetAck);
    const row: Record<string, unknown> = {
      employee_id: o.employeeId,
      lesson_id: o.lesson.id,
      quiz_score: o.score,
      quiz_total: total,
      quiz_passed: passed,
      last_attempt_at: new Date().toISOString(),
    };
    if (passed) row.completed_version = o.lesson.version;
    if (o.resetAck) Object.assign(row, { acknowledged: false, acknowledged_at: null });
    if (o.existing) return must(await supabase.from('lesson_progress').update(row).eq('id', o.existing.id).select('*').single());
    return must(await supabase.from('lesson_progress').insert({ ...row, acknowledged: false }).select('*').single());
  },
  async acknowledge(progressId: string): Promise<LessonProgress> {
    if (isDemo) return demo.acknowledge(progressId);
    return must(await supabase.from('lesson_progress').update({ acknowledged: true, acknowledged_at: new Date().toISOString() }).eq('id', progressId).select('*').single());
  },
  async signOff(employeeId: string, lessonId: string, managerId: string) {
    if (isDemo) return demo.signOff(employeeId, lessonId, managerId);
    const prog = must(await supabase.from('lesson_progress').select('id').eq('employee_id', employeeId).eq('lesson_id', lessonId).maybeSingle()) as { id: string } | null;
    if (!prog) throw new Error('No progress to sign off');
    const { error } = await supabase.rpc('sign_off_practical', { p_progress_id: prog.id });
    if (error) throw error;
  },
  async updateEmployee(id: string, p: Pick<Profile, 'full_name' | 'role' | 'job_title' | 'location' | 'active'>) {
    if (isDemo) return demo.updateEmployee(id, p);
    const { error } = await supabase.rpc('update_employee_profile', { p_employee_id: id, p_full_name: p.full_name, p_role: p.role, p_job_title: p.job_title, p_location: p.location, p_active: p.active });
    if (error) throw error;
  },
  async saveLesson(input: LessonInput, id?: string) {
    if (isDemo) return demo.saveLesson(input, id);
    const r = id ? await supabase.from('lessons').update(input).eq('id', id) : await supabase.from('lessons').insert(input);
    if (r.error) throw r.error;
  },
  async deleteLesson(id: string) {
    if (isDemo) return demo.deleteLesson(id);
    const { error } = await supabase.from('lessons').delete().eq('id', id);
    if (error) throw error;
  },
  async requireRetraining(id: string) {
    if (isDemo) return demo.requireRetraining(id);
    const { error } = await supabase.rpc('require_retraining', { p_lesson_id: id });
    if (error) throw error;
  },
  async addCategory(name: string, description: string) {
    if (isDemo) return demo.addCategory(name, description);
    const cats = await api.categories();
    const { error } = await supabase.from('categories').insert({ name, description, sort_order: cats.length + 1 });
    if (error) throw error;
  },
  async updateCategory(id: string, name: string, description: string) {
    if (isDemo) return demo.updateCategory(id, name, description);
    const { error } = await supabase.from('categories').update({ name, description }).eq('id', id);
    if (error) throw error;
  },
  async deleteCategory(id: string) {
    if (isDemo) return demo.deleteCategory(id);
    const { error } = await supabase.from('categories').delete().eq('id', id);
    if (error) throw error;
  },
  async createAssignment(input: AssignmentInput) {
    if (isDemo) return demo.createAssignment(input);
    const lesson = await api.lesson(input.lesson_id);
    const { error } = await supabase.from('assignments').insert({ ...input, assigned_version: lesson?.version ?? 1 });
    if (error) throw error;
  },
  async deleteAssignment(id: string) {
    if (isDemo) return demo.deleteAssignment(id);
    const { error } = await supabase.from('assignments').delete().eq('id', id);
    if (error) throw error;
  },
};
