/* In-memory demo backend. Used when Supabase env vars are missing (or ?demo=1),
   so the full UI can be previewed and tested without touching real data.
   All people below are fictional. */
import { jackDiagram, lotTagDiagram, rackDiagram } from './diagrams';
import type { Assignment, AssignmentInput, Category, EmployeeTrainingRow, Lesson, LessonInput, LessonProgress, Profile, QuizQuestion } from './types';

const now = Date.now();
const iso = (daysAgo = 0) => new Date(now - daysAgo * 86400000).toISOString();
const day = (offset: number) => {
  // local calendar date, so due dates don't shift a day near midnight UTC
  const d = new Date(now + offset * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
let seq = 1000;
const uid = (p: string) => `${p}_${(seq++).toString(36)}`;

const q = (question: string, options: string[], answer_index: number): QuizQuestion => ({ question, options, answer_index });

const categories: Category[] = [
  { id: 'cat_safety', name: 'Floor Safety', description: 'Moving product without hurting yourself or anyone else.', sort_order: 1, created_at: iso(90) },
  { id: 'cat_lotting', name: 'Lotting & Listing', description: 'Turning pallets into clean, sellable lots.', sort_order: 2, created_at: iso(90) },
  { id: 'cat_pickup', name: 'Checkout & Pickup', description: 'Getting paid lots to the right customer, fast.', sort_order: 3, created_at: iso(90) },
  { id: 'cat_night', name: 'Auction Night', description: 'What happens when lots close and cards are charged.', sort_order: 4, created_at: iso(60) },
];

const L = (id: string, category_id: string, sort_order: number, title: string, summary: string, instructions: string, quiz: QuizQuestion[], extra: Partial<Lesson> = {}): Lesson => ({
  id, category_id, sort_order, title, summary, instructions,
  video_url: '', screenshot_urls: [], requires_practical: false, practical_notes: '',
  quiz_questions: quiz, passing_score: Math.max(1, quiz.length - 1), version: 1, created_at: iso(80), ...extra,
});

const lessons: Lesson[] = [
  L('les_jack', 'cat_safety', 1, 'Pallet jack basics', 'Lift, steer and park a manual pallet jack without tipping a load.',
    'Check the forks and wheels before every shift.\nCenter the forks under the pallet — both forks fully in.\nPump the handle until the pallet clears the floor by about an inch.\nPull, don\'t push, on long runs. Push only for short, straight moves.\nLower the load fully before you let go of the handle.\nPark the jack with forks down, out of the aisle.',
    [q('How far should the pallet clear the floor?', ['About an inch', 'Knee height', 'As high as it goes'], 0), q('On a long run you should…', ['Push the jack', 'Pull the jack', 'Ride the jack'], 1), q('Where do you park the jack?', ['In the aisle, forks up', 'Out of the aisle, forks down', 'Next to the dock door'], 1)],
    { requires_practical: true, practical_notes: 'Watch them move a full pallet 30\u00a0ft, turn into a bay and park forks\u2011down.', video_url: 'demo://pallet-jack', screenshot_urls: [jackDiagram()] }),
  L('les_rack', 'cat_safety', 2, 'Aisle & rack safety', 'Keep aisles clear and racks loaded the right way — heavy low, light high.',
    'Heavy and bulky items go on the bottom two beams.\nNever climb racking. Use the rolling ladder.\nKeep 3 ft of aisle clear at all times.\nReport a bent upright or beam right away — do not load it.\nNothing overhangs the beam by more than 3 inches.',
    [q('Where do heavy items go?', ['Top shelf', 'Bottom two beams', 'Anywhere it fits'], 1), q('A beam is bent. You…', ['Load it lightly', 'Report it and don\'t load it', 'Bend it back'], 1), q('How much aisle must stay clear?', ['1 ft', '3 ft', 'None'], 1)],
    { version: 2, screenshot_urls: [rackDiagram()] }),
  L('les_lift', 'cat_safety', 3, 'Lifting without injury', 'Use your legs, keep it close, and ask for a second set of hands over 50 lb.',
    'Size up the load — test one corner first.\nFeet shoulder-width, bend at the knees.\nKeep the load close to your body.\nTurn with your feet, never twist your back.\nOver 50 lb or awkward? Get a teammate.',
    [q('Over 50 lb you should…', ['Lift fast', 'Get a teammate', 'Drag it'], 1), q('To turn with a load…', ['Twist at the waist', 'Move your feet', 'Lean back'], 1)]),
  L('les_lot', 'cat_lotting', 1, 'Building a lot', 'Group items so a buyer knows exactly what they are bidding on.',
    'One lot = one tag. Every item in the lot goes in the same tote or on the same pallet.\nWrite the lot number on two sides.\nCount pieces and note any missing parts.\nKeep sets together — never split a matching set across lots.\nPhoto the lot before it leaves the lotting table.',
    [q('A lot number goes on…', ['One side', 'Two sides', 'The receipt'], 1), q('A matching set should be…', ['Split for more lots', 'Kept together', 'Thrown out'], 1), q('When do you photo the lot?', ['After pickup', 'Before it leaves the table', 'Never'], 1)],
    { requires_practical: true, practical_notes: 'Watch them build three lots from a mixed pallet, with tags and counts.', screenshot_urls: [lotTagDiagram()] }),
  L('les_photo', 'cat_lotting', 2, 'Photographing items for listing', 'Three clean photos sell a lot. Blurry ones cost us bids.',
    'Shoot on the white table under the light box.\nFirst photo: the whole lot.\nSecond: the label, model number or size.\nThird: any damage, up close.\nNo hands, no clutter, no other lots in frame.',
    [q('The first photo shows…', ['The damage', 'The whole lot', 'The tag only'], 1), q('Damage should be…', ['Hidden', 'Shown up close', 'Mentioned only in text'], 1)]),
  L('les_grade', 'cat_lotting', 3, 'Condition grading', 'New, open box, or as-is — grade it the same way every time.',
    'New: sealed, untouched packaging.\nOpen box: opened, all parts present, no damage.\nAs-is: missing parts, damage, or untested.\nWhen in doubt, grade down, not up.',
    [q('Opened but complete and undamaged is…', ['New', 'Open box', 'As-is'], 1), q('Unsure between two grades?', ['Grade up', 'Grade down', 'Skip it'], 1)]),
  L('les_checkin', 'cat_pickup', 1, 'Pickup window check-in', 'Find the buyer, confirm the invoice, and pull their lots in under five minutes.',
    'Greet the buyer and ask for their name and invoice number.\nLook up the invoice — it must show Paid.\nPrint or read the pick list.\nPull lots in lot-number order.\nHave the buyer check the lots before they leave the counter.',
    [q('Before pulling lots the invoice must show…', ['Pending', 'Paid', 'Any status'], 1), q('Pull lots in…', ['Any order', 'Lot-number order', 'Size order'], 1)],
    { video_url: 'demo://pickup' }),
  L('les_invoice', 'cat_pickup', 2, 'Verifying paid invoices', 'Spot an unpaid or mismatched invoice before product leaves the building.',
    'Match the buyer name to the invoice.\nCheck the status reads Paid — not Pending or Failed.\nCount the lots on the invoice against the pick list.\nIf anything does not match, stop and call a lead.',
    [q('The status reads Pending. You…', ['Release the lots', 'Stop and call a lead', 'Ask for cash'], 1), q('Lot count does not match. You…', ['Guess', 'Stop and call a lead', 'Give extra'], 1)]),
  L('les_load', 'cat_pickup', 3, 'Loading customer vehicles', 'Load safely, protect the product, and never let a buyer climb the dock.',
    'Ask where they want it before lifting.\nHeavy items first, flat on the floor of the vehicle.\nUse straps or tell the buyer to — we do not tie down loads.\nBuyers stay off the dock and out of the warehouse.',
    [q('Heavy items go…', ['On top', 'First, flat on the floor', 'In the cab'], 1), q('Can buyers come up on the dock?', ['Yes', 'No'], 1)],
    { requires_practical: true, practical_notes: 'Watch them load two vehicles at the pickup door.' }),
  L('les_close', 'cat_night', 1, 'Closing night checklist', 'Auctions close and cards charge between 6 and 10 PM. Here is what has to be ready.',
    'All lots for tonight are photographed and tagged.\nPickup shelves cleared for tomorrow.\nDoors locked at 6 PM sharp.\nLeads watch the dashboard for failed charges.',
    [q('Cards are charged…', ['In the morning', 'Between 6 and 10 PM', 'At pickup'], 1), q('Doors lock at…', ['5 PM', '6 PM', '10 PM'], 1)]),
  L('les_dispute', 'cat_night', 2, 'Handling disputes at pickup', 'Stay calm, write it down, and hand it to a lead.',
    'Listen first. Don\'t argue about the listing.\nWrite down the lot number and the problem.\nOffer to get a lead — never promise a refund.\nLog it in the dispute sheet before the end of your shift.',
    [q('Can you promise a refund?', ['Yes', 'No — get a lead'], 1), q('Disputes get logged…', ['Next week', 'Before the end of your shift'], 1)]),
];

const profiles: Profile[] = [
  { id: 'u_mgr', full_name: 'Morgan Hale', role: 'manager', job_title: 'Operations Manager', location: 'Harrison, AR', active: true, created_at: iso(200) },
  { id: 'u_jamie', full_name: 'Jamie Reyes', role: 'employee', job_title: 'Warehouse Associate', location: 'Harrison, AR', active: true, created_at: iso(120) },
  { id: 'u_sam', full_name: 'Sam Okafor', role: 'employee', job_title: 'Lotting Specialist', location: 'Harrison, AR', active: true, created_at: iso(110) },
  { id: 'u_taylor', full_name: 'Taylor Brooks', role: 'employee', job_title: 'Cashier', location: 'Springdale, AR', active: true, created_at: iso(70) },
  { id: 'u_riley', full_name: 'Riley Chen', role: 'employee', job_title: 'Floor Lead', location: 'Harrison, AR', active: true, created_at: iso(150) },
  { id: 'u_avery', full_name: 'Avery Lin', role: 'employee', job_title: 'Warehouse Associate', location: 'Springdale, AR', active: true, created_at: iso(30) },
  { id: 'u_casey', full_name: 'Casey Moreno', role: 'employee', job_title: 'Loader', location: 'Harrison, AR', active: true, created_at: iso(45) },
  { id: 'u_jordan', full_name: 'Jordan Pike', role: 'employee', job_title: '', location: '', active: true, created_at: iso(1) },
  { id: 'u_quinn', full_name: 'Quinn Harper', role: 'employee', job_title: 'Lotting Specialist', location: 'Springdale, AR', active: false, created_at: iso(300) },
];

const A = (lesson_id: string, o: Partial<Assignment>): Assignment => ({ id: uid('as'), lesson_id, assignee_id: null, job_title: '', location: '', assigned_version: lessons.find((l) => l.id === lesson_id)!.version, due_date: null, created_at: iso(40), ...o });

const assignments: Assignment[] = [
  A('les_jack', { due_date: day(-2) }),
  A('les_rack', { due_date: day(5) }),
  A('les_lift', {}),
  A('les_lot', { job_title: 'Lotting Specialist' }),
  A('les_photo', { job_title: 'Lotting Specialist', due_date: day(2) }),
  A('les_grade', { job_title: 'Lotting Specialist' }),
  A('les_lot', { assignee_id: 'u_riley' }),
  A('les_checkin', { job_title: 'Cashier' }),
  A('les_invoice', { job_title: 'Cashier', due_date: day(9) }),
  A('les_load', { job_title: 'Warehouse Associate' }),
  A('les_load', { job_title: 'Loader' }),
  A('les_checkin', { job_title: 'Loader' }),
  A('les_close', { location: 'Harrison, AR', due_date: day(12) }),
  A('les_dispute', { job_title: 'Floor Lead' }),
];

type P = Partial<LessonProgress> & { e: string; l: string };
const P = (e: string, l: string, s: 'q' | 'fail' | 'ack' | 'sign' | 'old', score?: number): P => {
  const lesson = lessons.find((x) => x.id === l)!;
  const total = lesson.quiz_questions.length;
  const base: P = { e, l, quiz_total: total, quiz_score: score ?? total, quiz_passed: true, acknowledged: true, acknowledged_at: iso(10), completed_version: lesson.version, last_attempt_at: iso(10) };
  if (s === 'fail') return { ...base, quiz_score: score ?? 0, quiz_passed: false, acknowledged: false, acknowledged_at: null };
  if (s === 'ack') return { ...base, acknowledged: false, acknowledged_at: null };
  if (s === 'sign') return { ...base };
  if (s === 'old') return { ...base, completed_version: lesson.version - 1, practical_signed_off: true };
  return { ...base, practical_signed_off: lesson.requires_practical, signed_off_by: lesson.requires_practical ? 'u_mgr' : null, signed_off_at: lesson.requires_practical ? iso(8) : null };
};

const seedProgress: P[] = [
  P('u_jamie', 'les_jack', 'sign'), P('u_jamie', 'les_rack', 'old'), P('u_jamie', 'les_lift', 'q'), P('u_jamie', 'les_load', 'fail', 0),
  P('u_sam', 'les_jack', 'q'), P('u_sam', 'les_rack', 'q'), P('u_sam', 'les_lift', 'q'), P('u_sam', 'les_lot', 'sign'), P('u_sam', 'les_photo', 'q'), P('u_sam', 'les_grade', 'ack'),
  P('u_taylor', 'les_jack', 'q'), P('u_taylor', 'les_checkin', 'q'), P('u_taylor', 'les_invoice', 'fail', 1),
  P('u_riley', 'les_jack', 'q'), P('u_riley', 'les_rack', 'q'), P('u_riley', 'les_lift', 'q'), P('u_riley', 'les_lot', 'q'), P('u_riley', 'les_close', 'q'), P('u_riley', 'les_dispute', 'q'),
  P('u_avery', 'les_lift', 'q'), P('u_avery', 'les_jack', 'ack'),
  P('u_casey', 'les_jack', 'q'), P('u_casey', 'les_rack', 'old'), P('u_casey', 'les_load', 'sign'), P('u_casey', 'les_checkin', 'q'), P('u_casey', 'les_close', 'fail', 0),
];

const progress: LessonProgress[] = seedProgress.map(({ e, l, ...rest }) => recompute({
  id: uid('pr'), employee_id: e, lesson_id: l, quiz_score: 0, quiz_total: 0, quiz_passed: false, acknowledged: false, acknowledged_at: null,
  practical_signed_off: false, signed_off_by: null, signed_off_at: null, qualified: false, completed_version: 0, last_attempt_at: iso(10), created_at: iso(20), ...rest,
}));

function recompute(p: LessonProgress): LessonProgress {
  const lesson = lessons.find((l) => l.id === p.lesson_id);
  p.qualified = p.quiz_passed && p.acknowledged && (!lesson?.requires_practical || p.practical_signed_off);
  return p;
}

const db = { categories, lessons, profiles, assignments, progress };
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const wait = (ms = 140) => new Promise((r) => setTimeout(r, ms));

function matches(a: Assignment, e: Profile) {
  if (a.assignee_id) return a.assignee_id === e.id;
  // People still waiting on setup (no job yet) only get direct assignments.
  if (!e.job_title) return false;
  // Fixed rule: an empty job/location means "any" (the original view missed the "everyone" case).
  const jobOk = a.job_title === '' || a.job_title === e.job_title;
  const locOk = a.location === '' || a.location === e.location;
  return jobOk && locOk;
}

function trainingRows(): EmployeeTrainingRow[] {
  const rows: EmployeeTrainingRow[] = [];
  for (const e of db.profiles.filter((p) => p.active && p.role === 'employee')) {
    const seen = new Set<string>();
    for (const a of db.assignments) {
      if (!matches(a, e) || seen.has(a.lesson_id)) continue;
      seen.add(a.lesson_id);
      const l = db.lessons.find((x) => x.id === a.lesson_id);
      if (!l) continue;
      const c = db.categories.find((x) => x.id === l.category_id)!;
      const p = db.progress.find((x) => x.employee_id === e.id && x.lesson_id === l.id);
      rows.push({
        employee_id: e.id, employee_name: e.full_name, job_title: e.job_title, location: e.location,
        assignment_id: a.id, lesson_id: l.id, lesson_title: l.title, category_name: c.name, category_sort: c.sort_order, lesson_sort: l.sort_order,
        assigned_version: a.assigned_version, current_version: l.version, due_date: a.due_date, requires_practical: l.requires_practical,
        quiz_passed: p?.quiz_passed ?? false, acknowledged: p?.acknowledged ?? false, practical_signed_off: p?.practical_signed_off ?? false,
        qualified: p?.qualified ?? false, completed_version: p?.completed_version ?? 0, quiz_score: p?.quiz_score ?? 0, quiz_total: p?.quiz_total ?? 0,
        retraining_required: a.assigned_version > (p?.completed_version ?? 0),
      });
    }
  }
  return rows.sort((a, b) => a.category_sort - b.category_sort || a.lesson_sort - b.lesson_sort);
}

export const demo = {
  profileById: async (id: string) => clone(db.profiles.find((p) => p.id === id) ?? null),
  profiles: async () => { await wait(); return clone([...db.profiles].sort((a, b) => a.full_name.localeCompare(b.full_name))); },
  training: async (employeeId?: string) => { await wait(); return clone(trainingRows().filter((r) => !employeeId || r.employee_id === employeeId)); },
  categories: async () => { await wait(80); return clone([...db.categories].sort((a, b) => a.sort_order - b.sort_order)); },
  lessons: async () => { await wait(80); return clone([...db.lessons].sort((a, b) => a.sort_order - b.sort_order)); },
  lesson: async (id: string) => { await wait(); return clone(db.lessons.find((l) => l.id === id) ?? null); },
  progress: async (lessonId: string, employeeId: string) => clone(db.progress.find((p) => p.lesson_id === lessonId && p.employee_id === employeeId) ?? null),
  assignments: async () => { await wait(80); return clone(db.assignments); },

  submitQuiz: async (employeeId: string, lessonId: string, score: number, total: number, passed: boolean, version: number, resetAck: boolean) => {
    await wait(260);
    let p = db.progress.find((x) => x.employee_id === employeeId && x.lesson_id === lessonId);
    if (!p) {
      p = { id: uid('pr'), employee_id: employeeId, lesson_id: lessonId, quiz_score: 0, quiz_total: 0, quiz_passed: false, acknowledged: false, acknowledged_at: null, practical_signed_off: false, signed_off_by: null, signed_off_at: null, qualified: false, completed_version: 0, last_attempt_at: iso(), created_at: iso() };
      db.progress.push(p);
    }
    Object.assign(p, { quiz_score: score, quiz_total: total, quiz_passed: passed, last_attempt_at: iso() });
    if (passed) p.completed_version = version;
    if (resetAck) Object.assign(p, { acknowledged: false, acknowledged_at: null });
    return clone(recompute(p));
  },
  acknowledge: async (progressId: string) => {
    await wait(260);
    const p = db.progress.find((x) => x.id === progressId)!;
    Object.assign(p, { acknowledged: true, acknowledged_at: iso() });
    return clone(recompute(p));
  },
  signOff: async (employeeId: string, lessonId: string, managerId: string) => {
    await wait(300);
    const p = db.progress.find((x) => x.employee_id === employeeId && x.lesson_id === lessonId);
    if (!p) throw new Error('No progress');
    Object.assign(p, { practical_signed_off: true, signed_off_by: managerId, signed_off_at: iso() });
    recompute(p);
  },
  updateEmployee: async (id: string, patch: Pick<Profile, 'full_name' | 'role' | 'job_title' | 'location' | 'active'>) => {
    await wait(260);
    Object.assign(db.profiles.find((p) => p.id === id)!, patch);
  },
  saveLesson: async (input: LessonInput, id?: string) => {
    await wait(300);
    if (id) Object.assign(db.lessons.find((l) => l.id === id)!, input);
    else db.lessons.push({ ...input, id: uid('les'), version: 1, created_at: iso() });
  },
  deleteLesson: async (id: string) => {
    await wait(200);
    db.lessons = db.lessons.filter((l) => l.id !== id);
    db.assignments = db.assignments.filter((a) => a.lesson_id !== id);
    db.progress = db.progress.filter((p) => p.lesson_id !== id);
  },
  requireRetraining: async (id: string) => {
    await wait(260);
    const l = db.lessons.find((x) => x.id === id)!;
    l.version += 1;
    db.assignments.filter((a) => a.lesson_id === id).forEach((a) => (a.assigned_version = l.version));
  },
  addCategory: async (name: string, description: string) => {
    await wait(200);
    if (db.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new Error('exists');
    db.categories.push({ id: uid('cat'), name, description, sort_order: db.categories.length + 1, created_at: iso() });
  },
  updateCategory: async (id: string, name: string, description: string) => {
    await wait(200);
    Object.assign(db.categories.find((c) => c.id === id)!, { name, description });
  },
  deleteCategory: async (id: string) => {
    await wait(200);
    const ids = db.lessons.filter((l) => l.category_id === id).map((l) => l.id);
    db.categories = db.categories.filter((c) => c.id !== id);
    for (const lid of ids) await demo.deleteLesson(lid);
  },
  createAssignment: async (input: AssignmentInput) => {
    await wait(260);
    const l = db.lessons.find((x) => x.id === input.lesson_id)!;
    db.assignments.push({ ...input, id: uid('as'), assigned_version: l.version, created_at: iso() });
  },
  deleteAssignment: async (id: string) => {
    await wait(200);
    db.assignments = db.assignments.filter((a) => a.id !== id);
  },
};

export const DEMO_PEOPLE = ['u_mgr', 'u_jamie', 'u_sam', 'u_taylor', 'u_casey'];
