export type Role = 'employee' | 'manager';

export interface Profile {
  id: string;
  full_name: string;
  role: Role;
  job_title: string;
  location: string;
  active: boolean;
  created_at: string;
}

export interface Category {
  id: string;
  name: string;
  description: string;
  sort_order: number;
  created_at: string;
}

export interface QuizQuestion {
  question: string;
  options: string[];
  answer_index: number;
}

export interface Lesson {
  id: string;
  category_id: string;
  title: string;
  summary: string;
  instructions: string;
  video_url: string;
  screenshot_urls: string[];
  requires_practical: boolean;
  practical_notes: string;
  quiz_questions: QuizQuestion[];
  passing_score: number;
  version: number;
  sort_order: number;
  created_at: string;
}

export type LessonInput = Omit<Lesson, 'id' | 'version' | 'created_at'>;

export interface Assignment {
  id: string;
  lesson_id: string;
  assignee_id: string | null;
  job_title: string;
  location: string;
  assigned_version: number;
  due_date: string | null;
  created_at: string;
}

export type AssignmentInput = Pick<Assignment, 'lesson_id' | 'assignee_id' | 'job_title' | 'location' | 'due_date'>;

export interface LessonProgress {
  id: string;
  employee_id: string;
  lesson_id: string;
  quiz_score: number;
  quiz_total: number;
  quiz_passed: boolean;
  acknowledged: boolean;
  acknowledged_at: string | null;
  practical_signed_off: boolean;
  signed_off_by: string | null;
  signed_off_at: string | null;
  qualified: boolean;
  completed_version: number;
  last_attempt_at: string;
  created_at: string;
}

export interface EmployeeTrainingRow {
  employee_id: string;
  employee_name: string;
  job_title: string;
  location: string;
  assignment_id: string;
  lesson_id: string;
  lesson_title: string;
  category_name: string;
  category_sort: number;
  lesson_sort: number;
  assigned_version: number;
  current_version: number;
  due_date: string | null;
  requires_practical: boolean;
  quiz_passed: boolean;
  acknowledged: boolean;
  practical_signed_off: boolean;
  qualified: boolean;
  completed_version: number;
  quiz_score: number;
  quiz_total: number;
  retraining_required: boolean;
}
