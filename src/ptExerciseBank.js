// #465: specific, filmed movements for the PT Recovery Engine (#454).
//
// The engine's library (ptEngine.js REGIONS, copied verbatim from Cordell's
// source) names each prescription generically — "Mini-squat / wall sit",
// "Banded IR/ER (progressive)". This file maps every one of those generic
// names to the NBP exercise-bank movement(s) that carry out that prescription,
// so a saved PT plan lands on the athlete's calendar with real exercise names
// and their video links (exercise_videos.video_url -> training_exercises.video_url).
//
// Each value is an ordered progression through the phase the item sits in:
// the first name is used in the early weeks of the phase, the last in its
// final weeks (e.g. assisted -> full Nordic). A single name is used all phase.
// Items with no honest bank equivalent (edema control, "protect per protocol",
// patellar mobilisations, …) are deliberately absent and stay as the engine's
// generic text with no link. Names must match exercise_videos.name; a name
// that no longer resolves in the library falls back to the generic text too.
//
// Keyed by the engine's item text, not by region: the few items that appear
// in more than one region ("Single-leg balance (open→closed→foam)", "Running
// progression (straight→cut)") get the same movement everywhere.
export const PT_BANK_MAP = {
  // ---- Knee ----
  'Straight-leg raise, 4-way': ['Supine Straight Leg Lift with Band Pull Down', 'Eccentric Straight Leg Raises'],
  'Ankle pumps + calf isometrics': ['Seated Calf Raise'],
  'Stationary bike': ['Bike'],
  'Mini-squat / wall sit': ['Isometric Wall Sit', 'BW Squats'],
  'Low step-ups': ['Step-Ups', 'DB Loaded Step Up'],
  'Single-leg balance (eyes open→closed→foam)': ['Banded Single Leg Balance'],
  'Goblet squat / leg press': ['KB Goblet Squat', 'Belt Squat'],
  'Bulgarian split squat / step-down': ['Front Foot Elevated DB Split Squat Hold', 'DB RFESS'],
  'Hamstring curl → Nordic progression': ['Swiss Ball Leg Curl', 'TRX Assisted Nordic Curl', 'Nordic Hamstring Curls'],
  'Single-leg RDL': ['assisted sl db rdl', 'SL DB RDL'],
  'Hip abductor + calf raise': ['Mini Band Monster Walks'],
  'Jump-landing & deceleration (drop-and-stick)': ['Plyo Box Drop Squat Catch', 'SL Lateral & Forward Bounds To Drop Catches'],
  'Hop battery (single / triple / crossover)': ['sl pogo hops', 'Speed Single-Leg Jumps'],
  'Change-of-direction / agility → cutting': ['5 Point Box Drill (Box)', '20 Yard Shuttle'],
  'Plyometric loading (bounds, depth jumps)': ['Lateral Bounds', 'depth jump to broad jump'],
  'Sport-specific reactive drills': ['Agility Ladder'],

  // ---- Shoulder ----
  'Pendulums + scapular sets': ['Scapular Retraction'],
  'Passive / assisted ROM in allowed arcs': ['Shoulder ER With PVC Pipe'],
  'Elbow/wrist/hand AROM + grip': ['Wrist Circles'],
  'Sub-max cuff isometrics at neutral': ['Shoulder External/Internal Rotation Iso Hold'],
  'Active-assisted flexion/ER (cane, pulley)': ['Shoulder ER With PVC Pipe', 'Dowel Shoulder Rotations'],
  'Table slides / wall walks': ['Wall Slides', 'Y Wall Slides'],
  'Scapular control (serratus, lower trap)': ['Serratus Wall Slide', 'Y Wall Slides With Lift Offs'],
  'Rhythmic stabilization (light)': ['Shoulder Perturbations'],
  'Banded IR/ER (progressive)': ['Shoulder Internal and External Banded Rotations', 'Cable Shoulder ER'],
  'Scapular strengthening (rows, prone Y/T/W)': ['Prone I, T, Y\'s', 'chest supported db row'],
  'Closed-chain (wall/quadruped → push-up plus)': ['Scapular Pushup', 'Push-Ups'],
  'Progressive press & pull in available range': ['TRX Row', 'Half-kneeling landmine press'],
  'Cuff endurance (side-lying ER, prone)': ['Side Lying ER'],
  'Plyometric ball drills (chest, overhead)': ['Med Ball Chest Pass', 'Overhead Med Ball Slam'],
  'Overhead & loaded functional patterns': ['KB Bottoms Up Press', 'Overhead KB walks'],
  'Interval throwing / serving progression': ['Driveline Extension Long Toss Series up to 60% RPE'],
  'Eccentric & rate-of-loading for demand': ['Bent Over Reverse Fly Catches'],

  // ---- Ankle / foot ----
  'Ankle pumps & alphabet (pain-free)': ['Ankle Mobility Drill'],
  'Weight-bearing dorsiflexion (knee-to-wall)': ['Ankle Mobility Drill', 'Pike Ankle Mob'],
  'Seated → standing heel raises': ['Seated Calf Raise', 'Calf Raises BW'],
  'Single-leg balance (open→closed→foam)': ['Banded Single Leg Balance'],
  'Gait normalization on level ground': ['1 Mile Walk Outside'],
  'Banded 4-way ankle': ['Seated Tibialis Raises', 'Tibialis Curl'],
  'Heel-raise loading (bilateral→single)': ['Calf Raises BW', 'DB Standing Calf Raise'],
  'Balance on unstable surface': ['Banded Single Leg Balance'],
  'Posterior-chain & hip control': ['SL Glute Bridge', 'SL DB RDL'],
  'Calf endurance (single-leg to fatigue)': ['Calf Raises BW'],
  'Hopping & landing progressions': ['Pogo Hop', 'sl pogo hops'],
  'Lateral bounding & multidirectional agility': ['Lateral Bounds', 'Speed Lateral Bounds'],
  'Running progression (straight→cut)': ['60 Yard Striders', '20 Yard Shuttle'],
  'Reactive sport-specific change-of-direction': ['5 Point Box Drill (Cross)'],

  // ---- Lower back ----
  'Diaphragmatic breathing + gentle nerve glides': ['Bandage / Banded Diaphragm Biggest Inhale to Exhales'],
  'Frequent walking (avoid bed rest)': ['1 Mile Walk Outside'],
  'Cat-camel + hip-hinge patterning': ['Cat Cow', 'Feeling hip Hinge'],
  'Core motor control: dead-bug, bird-dog': ['Deadbug', 'Bird Dogs'],
  'Side-plank progression': ['Side Plank', 'Side Plank with Reach'],
  'Hip mobility (flexors, rotators)': ['hip flexor stretch', 'Seated 90/90 Rotations'],
  'Graded walking program': ['1 Mile Walk Outside'],
  'Hip hinge (RDL, kettlebell) with control': ['Dumbbell Romanian Deadlift', 'Kettlebell Swing'],
  'Squat / carry patterns': ['KB Goblet Squat', 'Farmers Walks'],
  'Trunk endurance (McGill big-3 progression)': ['Bird Dogs', 'Side Plank'],
  'Glute & posterior-chain strengthening': ['SL Glute Bridge', 'Hip Thrust'],
  'Anti-rotation (Pallof, chops)': ['WIde Stance Anti-Rotation Cable Chop', 'Woodchop'],
  'Loaded lifting to task demand (deadlift progression)': ['trap bar deadlift', 'conventional deadlift'],
  'Rotational & anti-rotation power': ['Med Ball Rotational Throws Both Sides'],
  'Work/sport simulation (lift, carry, twist)': ['Loaded Carry'],

  // ---- Hip / groin ----
  'Pain-free hip ROM in allowed range': ['Hip Circles'],
  'Glute activation (bridges, clams)': ['Basic Bridge', 'Isometric Glute Bridge Hold'],
  'Hip mobility (flexor, rotator) drills': ['hip flexor stretch', 'Seated 90/90 Rotations'],
  'Bridging & banded hip series': ['Basic Bridge', 'SL Glute Bridge'],
  'Balance & single-leg stance': ['Banded Single Leg Balance'],
  'Copenhagen adductor (intro, short lever)': ['Copenhagen Plank'],
  'Copenhagen adductor progression': ['Copenhagen Plank'],
  'Hip abductor / thrust': ['Standing Hip Abduction', 'Hip Thrust'],
  'Split squat / single-leg RDL': ['Bulgarian Split Squat', 'SL DB RDL'],
  'Progressive squat/deadlift patterns': ['KB Goblet Squat', 'trap bar deadlift'],
  'Pelvic control under load (carries)': ['DB Suitcase Carry'],
  'Change-of-direction & cutting mechanics': ['5 Point Box Drill (Box)', '20 Yard Shuttle'],
  'Kicking / sprint progression (as relevant)': ['60 Yard Striders', '20 Yard Sprints'],
  'Reactive multidirectional agility': ['Agility Ladder'],
  'Sport-specific power & deceleration': ['Lateral Bounds', 'Speed Skater'],

  // ---- Hamstring / thigh ----
  'Pain-free inner-range isometric holds': ['Isometric Glute Bridge Hold'],
  'Gentle ROM & walking in tolerance': ['1 Mile Walk Outside'],
  'Isometrics → light isotonic curls': ['Banded Hamstring Curls', 'prone banded hamstring curls'],
  'Hip-hinge patterning & glute work': ['Feeling hip Hinge', 'Basic Bridge'],
  'Bridges / single-leg extensor control': ['Basic Bridge', 'SL Glute Bridge'],
  'Low-speed treadmill / bike': ['Bike'],
  'Eccentric loading (Nordic progression)': ['TRX Assisted Nordic Curl', 'Nordic Hamstring Curls'],
  'Lengthened-position loading (Askling-style)': ['Hamstring Slider Curl', 'Eccentric Barbell RDL'],
  'RDL / single-leg RDL': ['Dumbbell Romanian Deadlift', 'SL DB RDL'],
  'Hip & trunk control': ['Physio SL RDL Deadbug'],
  'Hamstring endurance': ['Swiss Ball Leg Curl'],
  'High-speed running program (graded)': ['60 Yard Striders', '30 Yard Sprints'],
  'Acceleration/deceleration & sprint mechanics': ['A skips', '20 Yard Sprints'],
  'Reactive running & cutting': ['20 Yard Shuttle'],
  'Maximal sprinting tolerance': ['30 Yard Sprints'],

  // ---- Calf / Achilles ----
  'Ankle ROM within comfort': ['Ankle Mobility Drill'],
  'Bilateral heel raises (seated→standing)': ['Seated Calf Raise', 'Calf Raises BW'],
  'Progressive calf loading through range': ['Calf Raises BW', 'Calf Eccentrics (2 Up, 1 Down)'],
  'Balance & gait normalization': ['Banded Single Leg Balance'],
  'Ankle dorsiflexion mobility': ['Ankle Mobility Drill', 'Pike Ankle Mob'],
  'Heavy-slow resistance calf raise (straight & bent knee)': ['DB Standing Calf Raise', 'Seated Calf Raises'],
  'Single-leg heel-raise progression': ['Calf Raises BW', 'DB Loaded Calf Raises'],
  'Posterior-chain & hip strengthening': ['SL Glute Bridge', 'SL DB RDL'],
  'Soleus-biased seated raise': ['Seated Calf Raise'],
  'Calf endurance to fatigue': ['Calf Raises BW'],
  'Hopping & pogo progressions (energy storage)': ['Pogo Hop', 'sl pogo hops'],
  'Skipping / bounding': ['A skips', 'Lateral Bounds'],
  'Reactive sport-specific plyometrics': ['Speed Single-Leg Jumps'],

  // ---- Elbow ----
  'Pain-free elbow/wrist ROM in allowed range': ['Wrist Circles', 'Elbow CARS'],
  'Grip & forearm isometrics (submax)': ['Claw / Hand Series'],
  'Progressive flexion/extension & forearm rotation': ['Club Pronations', 'Club Supinations'],
  'Light wrist/forearm strengthening': ['Wrist Flexions', 'Wrist Extensions'],
  'Scapular & shoulder base work': ['Prone I, T, Y\'s'],
  'Nerve glides if indicated': ['Ulnar Lateral Flossing'],
  'Forearm/wrist & grip loading': ['Wrist Pronation With Dumbbell', 'Wrist Rollers'],
  'Eccentric wrist work (epicondylalgia)': ['Wrist Extension With DB'],
  'Shoulder & scapular strengthening': ['Prone I, T, Y\'s', 'Cable Shoulder ER'],
  'Progressive loading to task demand': ['Rice Bucket'],
  'Forearm endurance': ['Wrist Rollers'],
  'Plyometric & rhythmic stabilization': ['Shoulder Perturbations', 'Lying Bench 90 / 90 ER Ball Drops'],
  'Interval throwing / racquet progression': ['Driveline Extension Long Toss Series up to 60% RPE'],
  'Return-to-throw milestones (UCL/throwers)': ['Weighted Ball Catch Play & Extension Toss to Tolerance'],

  // ---- Neck ----
  'Pain-free active ROM all planes': ['Neck Circles', 'Neck CARS'],
  'Postural & breathing resets': ['Bandage / Banded Diaphragm Biggest Inhale to Exhales'],
  'Cervical & thoracic mobility': ['Quadruped T Spine Rotations', 'T Spine Mob from Bench'],
  'Scapular & postural endurance': ['Band Pull Aparts', 'Wall Angels With Band'],
  'Progressive neck & scapular strengthening': ['Band Face Pulls', 'Shrugs'],
  'Thoracic extension & postural loading': ['T-spine Extension from bench', 'Prone I, T, Y\'s'],
  'Upper-back & shoulder strengthening': ['TRX Row', 'chest supported db row'],
  'Load & task-specific endurance': ['Farmers Walks'],

  // ---- Wrist / hand ----
  'Pain-free wrist/hand ROM in allowed range': ['Wrist Circles'],
  'Tendon glides & edema control': ['Fist Series'],
  'Grip isometrics (submax)': ['Palms Together Holds'],
  'Grip & pinch progression (light)': ['Finger Flexions', 'Plate Pinch'],
  'Intrinsic hand strengthening': ['Finger Extensions', 'Claw / Hand Series'],
  'Progressive grip/wrist loading': ['Wrist Curl', 'Wrist Rollers'],
  'Forearm eccentric work': ['Wrist Extension With DB'],
  'Kinetic-chain (elbow/shoulder) support': ['Prone I, T, Y\'s'],
  'Load to occupational/sport demand': ['Rice Bucket'],
  'Weight-bearing & impact tolerance (as relevant)': ['Bear Crawl', 'Push-Ups'],

  // ---- General / other ----
  'Pain-free active movement of the region': ['CARS'],
  'Progressive ROM & mobility': ['Worlds greatest'],
  'Motor-control & activation drills': ['Bird Dogs', 'Deadbug'],
  'Balance & general conditioning': ['Banded Single Leg Balance', 'Bike'],
  'Graded return to daily movement': ['1 Mile Walk Outside'],
};

// Which pick of an item's progression applies `weekInPhase` weeks into a
// phase that lasts `phaseWeeks` weeks (0-based week, so week 0 = first pick).
export function bankPickFor(itemName, weekInPhase, phaseWeeks) {
  const picks = PT_BANK_MAP[itemName];
  if (!picks || !picks.length) return null;
  const len = Math.max(1, phaseWeeks || 1);
  const frac = Math.min(0.999, Math.max(0, (weekInPhase || 0) / len));
  return picks[Math.floor(frac * picks.length)];
}

// Resolve an engine item to { name, video_url } from the loaded library
// (`byKey` = useExerciseVideos().byKey, keyed by exercise_videos.name_key,
// which is the name trimmed and lower-cased — same rule as ExerciseNameInput).
// null when the item has no mapping or the mapped movement left the library.
export function resolveBankExercise(itemName, weekInPhase, phaseWeeks, byKey) {
  const pick = bankPickFor(itemName, weekInPhase, phaseWeeks);
  if (!pick || !byKey) return null;
  const row = byKey[pick.trim().toLowerCase()];
  if (!row) return null;
  return { name: row.name || pick, video_url: row.video_url || null };
}
