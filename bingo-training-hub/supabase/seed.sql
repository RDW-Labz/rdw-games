-- BinGo Training Hub — demo content
-- Safe to re-run: categories/lessons/assignments are guarded against duplicates.
-- Demo auth users are NOT created here; create them in the dashboard or with the
-- Admin API, then this script assigns their roles and titles by email.

-- ===== demo profile roles =====
WITH data(email, role, job_title, location) AS (
  VALUES
    ('manager@bingo.test', 'manager',  'Operations Manager',  'Main Warehouse'),
    ('jamie@bingo.test',   'employee', 'Warehouse Associate', 'Main Warehouse'),
    ('sam@bingo.test',     'employee', 'Lotting Specialist',  'Main Warehouse'),
    ('taylor@bingo.test',  'employee', 'Cashier',             'Front Counter'),
    ('morgan@bingo.test',  'employee', 'Floor Lead',          'Main Warehouse')
)
UPDATE profiles p
SET role = d.role, job_title = d.job_title, location = d.location
FROM data d
JOIN auth.users u ON u.email = d.email
WHERE p.id = u.id;

-- ===== categories =====
INSERT INTO categories (name, description, sort_order) VALUES
  ('Safety & Compliance', 'Required safety practices and compliance basics.', 1),
  ('Auction Operations',  'How lots move from intake to sale.', 2),
  ('Customer Service',    'Working with buyers and sellers.', 3),
  ('Systems & Tools',     'Using the BinGo platform and internal tools.', 4)
ON CONFLICT (name) DO NOTHING;

-- ===== lessons =====
INSERT INTO lessons (category_id, title, summary, instructions, requires_practical, practical_notes, quiz_questions, passing_score, sort_order)
SELECT c.id, 'Warehouse Safety Basics',
  'PPE, safe lifting, and hazard reporting on the warehouse floor.',
  $txt$1. Wear your safety vest and closed-toe shoes whenever you are on the warehouse floor.
2. Inspect the floor for spills, loose pallets, and blocked aisles before you start.
3. Lift with your knees, keep the load close, and ask for help with anything over 50 lbs.
4. Report every hazard to your floor lead immediately — do not wait until the end of shift.
5. Keep emergency exits and fire equipment clear at all times.$txt$,
  true,
  'Manager observes PPE use, lifting technique, and a hazard-reporting walkthrough.',
  $json$[
    {"question":"What should you do first when you spot a spill on the warehouse floor?","options":["Walk around it","Mark the area and report it","Wait for someone else to clean it","Cover it with cardboard"],"answer_index":1},
    {"question":"Which technique is correct for lifting a heavy box?","options":["Bend at the waist","Lift with your back","Bend your knees and keep the load close","Twist while lifting"],"answer_index":2},
    {"question":"When is PPE required on the warehouse floor?","options":["Only during auctions","At all times while working in the warehouse","Only when a manager is present","Only for new employees"],"answer_index":1}
  ]$json$::jsonb,
  2, 1
FROM categories c
WHERE c.name = 'Safety & Compliance'
  AND NOT EXISTS (SELECT 1 FROM lessons l WHERE l.title = 'Warehouse Safety Basics');

INSERT INTO lessons (category_id, title, summary, instructions, requires_practical, practical_notes, quiz_questions, passing_score, sort_order)
SELECT c.id, 'Hazardous Materials Handling',
  'Identify, label, and stage restricted items safely.',
  $txt$1. Restricted items include aerosols, flammables, lithium batteries, chemicals, and compressed gas.
2. Never place a restricted item in a standard lot.
3. Tag the item with a HAZMAT label and move it to the designated staging area.
4. Notify the lotting lead and record the item in the HAZMAT log.
5. If a container is leaking or unlabeled, stop and call a manager.$txt$,
  true,
  'Manager observes correct identification and staging of a practice restricted item.',
  $json$[
    {"question":"A lot contains an unlabeled aerosol can. What do you do?","options":["Tag it for sale","Set it aside and notify your manager","Throw it in the trash","Place it with electronics"],"answer_index":1},
    {"question":"Which items are restricted from standard lots?","options":["Furniture","Clothing","Hazardous or flammable materials","Books"],"answer_index":2}
  ]$json$::jsonb,
  1, 2
FROM categories c
WHERE c.name = 'Safety & Compliance'
  AND NOT EXISTS (SELECT 1 FROM lessons l WHERE l.title = 'Hazardous Materials Handling');

INSERT INTO lessons (category_id, title, summary, instructions, requires_practical, practical_notes, quiz_questions, passing_score, sort_order)
SELECT c.id, 'Lot Intake and Tagging',
  'Receive, photograph, tag, and shelve incoming lots.',
  $txt$1. Scan the lot number into the intake screen before touching the items.
2. Photograph the lot from the front and top so the condition is visible.
3. Attach the printed tag to a consistent, visible spot on the lot.
4. Note any damage, missing pieces, or oversized items in the intake record.
5. Shelve the lot in the aisle and bay shown on the tag.$txt$,
  false, '',
  $json$[
    {"question":"What is a lot?","options":["A single item","A group of items sold together","A storage shelf","A buyer account"],"answer_index":1},
    {"question":"Where does the lot tag go?","options":["Inside the box","On a visible, consistent spot on the lot","On the shelf only","Kept with the paperwork"],"answer_index":1},
    {"question":"What should you do if a lot tag is damaged or unreadable?","options":["Guess the lot number","Retag it and log the correction","Leave it untagged","Discard the lot"],"answer_index":1}
  ]$json$::jsonb,
  2, 1
FROM categories c
WHERE c.name = 'Auction Operations'
  AND NOT EXISTS (SELECT 1 FROM lessons l WHERE l.title = 'Lot Intake and Tagging');

INSERT INTO lessons (category_id, title, summary, instructions, requires_practical, practical_notes, quiz_questions, passing_score, sort_order)
SELECT c.id, 'Auction Day Floor Flow',
  'How lots move before, during, and after the auction.',
  $txt$1. Confirm every scheduled lot is staged and tagged before doors open.
2. Keep aisles clear for buyers and staff throughout the preview.
3. Only staging or floor lead team members move lots once the auction starts.
4. Direct condition questions to the floor lead and the listed condition notes.
5. After the hammer, move sold lots to the pickup queue in lot order.$txt$,
  false, '',
  $json$[
    {"question":"Who can move a lot after it has been staged for auction?","options":["Any employee","Only the staging or floor lead team","Any buyer","The cashier"],"answer_index":1},
    {"question":"How should you handle a buyer question about a lot condition during the auction?","options":["Open the lot for inspection","Point them to the condition notes and a floor lead","Move the lot to pickup","Tell them to bid first"],"answer_index":1}
  ]$json$::jsonb,
  1, 2
FROM categories c
WHERE c.name = 'Auction Operations'
  AND NOT EXISTS (SELECT 1 FROM lessons l WHERE l.title = 'Auction Day Floor Flow');

INSERT INTO lessons (category_id, title, summary, instructions, requires_practical, practical_notes, quiz_questions, passing_score, sort_order)
SELECT c.id, 'Customer Pickup Procedures',
  'Verify buyers and release lots safely.',
  $txt$1. Greet the buyer and ask for their paid receipt and photo ID.
2. Confirm the name and lot numbers match the receipt.
3. For third-party pickup, collect the buyer's written authorization and a copy of their ID.
4. Walk the buyer to the lot, confirm the tag, and release the items.
5. Mark each lot as picked up in the system before the buyer leaves.
6. Note any damage disputes and call the manager.$txt$,
  false, '',
  $json$[
    {"question":"What must a buyer present before pickup?","options":["A bid number only","Their paid receipt and matching ID","A phone photo of the lot","Nothing if they know the lot number"],"answer_index":1},
    {"question":"A buyer says someone else will collect their items. What do you do?","options":["Release the items","Follow the authorized pickup process and verify documentation","Ask them to call later","Hold the items without a note"],"answer_index":1},
    {"question":"When should you mark a lot as picked up?","options":["Before the buyer arrives","After the items leave the building with the buyer","At the start of the auction","When the buyer pays"],"answer_index":1}
  ]$json$::jsonb,
  2, 1
FROM categories c
WHERE c.name = 'Customer Service'
  AND NOT EXISTS (SELECT 1 FROM lessons l WHERE l.title = 'Customer Pickup Procedures');

INSERT INTO lessons (category_id, title, summary, instructions, requires_practical, practical_notes, quiz_questions, passing_score, sort_order)
SELECT c.id, 'Cashier Closeout',
  'Count the drawer and document discrepancies.',
  $txt$1. Count your starting drawer with a witness before the first sale.
2. Keep all cash, checks, and receipts secured during the shift.
3. At closeout, count the drawer twice and record the totals.
4. Report any discrepancy to the manager immediately and document it.
5. Print the closeout summary and file it with the daily paperwork.$txt$,
  false, '',
  $json$[
    {"question":"When should the drawer be counted?","options":["Only at the end of the week","At the start and end of every shift","Only when a manager asks","Never"],"answer_index":1},
    {"question":"A payment discrepancy is found at closeout. What do you do?","options":["Adjust it yourself","Report it to the manager and document it","Ignore it if it is small","Leave a note for the next shift"],"answer_index":1}
  ]$json$::jsonb,
  1, 2
FROM categories c
WHERE c.name = 'Customer Service'
  AND NOT EXISTS (SELECT 1 FROM lessons l WHERE l.title = 'Cashier Closeout');

INSERT INTO lessons (category_id, title, summary, instructions, requires_practical, practical_notes, quiz_questions, passing_score, sort_order)
SELECT c.id, 'Using the BinGo Mobile App',
  'Find assignments, lessons, and sign-offs in the app.',
  $txt$1. Sign in with your work email and the password provided by your manager.
2. Open My Training to see every lesson assigned to you and its due date.
3. Tap a lesson to read the instructions, watch the video, and take the quiz.
4. After a practical demo, ask a manager to sign it off in the app.
5. A lesson is complete when the quiz is passed, the acknowledgement is checked, and any practical is signed off.$txt$,
  false, '',
  $json$[
    {"question":"Where do you find your assigned lessons?","options":["Settings","My Training","Messages","Reports"],"answer_index":1},
    {"question":"What should you do after completing a practical skill?","options":["Wait for a manager to sign it off","Mark it complete yourself","Skip it","Ask a coworker to approve it"],"answer_index":0}
  ]$json$::jsonb,
  1, 1
FROM categories c
WHERE c.name = 'Systems & Tools'
  AND NOT EXISTS (SELECT 1 FROM lessons l WHERE l.title = 'Using the BinGo Mobile App');

-- ===== assignments =====
INSERT INTO assignments (lesson_id, assignee_id, job_title, location, assigned_version, due_date)
SELECT l.id, NULL, v.job_title, v.location, l.version, v.due_date
FROM (VALUES
  ('Warehouse Safety Basics',      'Warehouse Associate', 'Main Warehouse', (CURRENT_DATE + 14)::date),
  ('Warehouse Safety Basics',      'Lotting Specialist',  'Main Warehouse', (CURRENT_DATE + 14)::date),
  ('Warehouse Safety Basics',      'Floor Lead',          'Main Warehouse', (CURRENT_DATE + 14)::date),
  ('Hazardous Materials Handling', 'Warehouse Associate', 'Main Warehouse', (CURRENT_DATE + 21)::date),
  ('Hazardous Materials Handling', 'Lotting Specialist',  'Main Warehouse', (CURRENT_DATE + 21)::date),
  ('Lot Intake and Tagging',       'Warehouse Associate', 'Main Warehouse', (CURRENT_DATE + 21)::date),
  ('Auction Day Floor Flow',       'Floor Lead',          'Main Warehouse', (CURRENT_DATE + 21)::date),
  ('Customer Pickup Procedures',   'Cashier',             'Front Counter',  (CURRENT_DATE + 7)::date),
  ('Cashier Closeout',             'Cashier',             'Front Counter',  (CURRENT_DATE + 7)::date)
) AS v(title, job_title, location, due_date)
JOIN lessons l ON l.title = v.title
WHERE NOT EXISTS (
  SELECT 1 FROM assignments a
  WHERE a.lesson_id = l.id
    AND a.assignee_id IS NULL
    AND a.job_title = v.job_title
    AND a.location = v.location
);

-- Mobile app lesson is assigned directly to every employee.
INSERT INTO assignments (lesson_id, assignee_id, job_title, location, assigned_version, due_date)
SELECT l.id, p.id, '', '', l.version, (CURRENT_DATE + 7)::date
FROM lessons l
JOIN profiles p ON p.role = 'employee' AND p.active = true
WHERE l.title = 'Using the BinGo Mobile App'
  AND NOT EXISTS (
    SELECT 1 FROM assignments a
    WHERE a.lesson_id = l.id AND a.assignee_id = p.id
  );
