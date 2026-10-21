/* eslint-disable */
/* ===========================================================================
 * ptEngine.js — "Return Path" recovery-plan engine (#454).
 *
 * Ported from Cordell's "PT Recovery Engine.html" (emailed 2026-08-28). The
 * capacity model, per-region exercise library, phase models and week builder
 * are copied VERBATIM from that file so the clinical content stays exactly as
 * written — edit the source document's wording here, not the logic. Only the
 * DOM reads were replaced with parameters (athlete level is passed in), and
 * the progress-check graders at the bottom return plain data instead of HTML.
 *
 * Education / decision-support only — it does not diagnose, and post-surgical
 * cases follow the surgeon's protocol (the UI says so on every plan).
 * ========================================================================= */

export const AGE_FACTOR={youth:2.6,teen:3.2,"20s":3.6,"30s":3.4,"4050s":2.9,"60s":2.3,"70s":1.7};
export const ATH_BONUS={none:0,youth:0.6,hs:1.1,college:1.6,pro:2.1};
export const AGE_NAME={youth:"Youth (8–12)",teen:"Teen (13–17)","20s":"20s","30s":"30s","4050s":"40s–50s","60s":"60s","70s":"70s+"};
export const ATH_NAME={none:"General population",youth:"Youth athlete",hs:"HS athlete",college:"College athlete",pro:"Professional athlete"};
export function capacity(a,ag){let raw=(AGE_FACTOR[ag]||3)+(ATH_BONUS[a]||0);let t=raw>=5?5:raw>=4.2?4:raw>=3.2?3:raw>=2.2?2:1;let l=null;
  if(ag==="youth"){if(t>2)t=2;l="youth";}else if(ag==="teen"){if(t>4)t=4;l="teen";}return{tier:t,ltad:l};}
export const CAP_WORD={5:"Elite / high",4:"High",3:"Moderate",2:"Conservative",1:"Cautious"};
export const CAP_DESC={5:"Large physiological reserve; aggressive but still criterion-gated progression — capacity never overrides tissue-healing timelines.",
4:"Robust capacity; standard-to-fast progression, early power/plyometric work once the phase allows.",
3:"Healthy-adult capacity; standard progression; power reserved for later phases.",
2:"Reduced reserve (older, deconditioned, or growing); slower progression, higher-rep loading, ongoing balance emphasis.",
1:"Low reserve / slower-healing tissue; gentle, function- and safety-first; longest timelines; falls prevention and pain-free ROM lead."};
export function dosing(t,ag){return{
  freq:{5:5,4:4,3:4,2:3,1:2}[t],
  setsN:{5:4,4:4,3:3,2:2,1:2}[t],
  reps:t>=4?"8–12":t===3?"8–12":"10–15",
  heal:{5:.9,4:1,3:1.1,2:1.25,1:1.4}[t],
  plyo:t>=3&&ag!=="youth",
  progr:{5:"reassess ~weekly; +5–10% load at criteria",4:"reassess ~1–2 wk; +5–10% at criteria",3:"reassess ~2 wk; +5–10% at criteria",2:"reassess ~2–3 wk; +2–5%, form over load",1:"reassess ~3 wk; tiny steps, pain-free ROM first"}[t]};}

/* ===================== EXERCISE LIBRARY =====================
   X(name, dose, progression).  pools: protect / motion / strength / advanced  */
export function X(n,d,p){return{n:n,d:d,p:p};}
export const REGIONS={
knee:{name:"Knee",
 pools:{
  protect:[X("Quad sets (isometric)","3×10 × 5s holds, 2–3×/day","→ straight-leg raise → add 1–2 lb cuff"),
    X("Straight-leg raise, 4-way","2×10 each way, daily","add ankle cuff weight as pain-free"),
    X("Heel slides / prone hangs (ROM)","2×10, 2×/day in allowed range","widen range weekly toward full symmetric ROM"),
    X("Patellar & soft-tissue mobilizations","1–2 min/direction, daily","taper as swelling resolves"),
    X("Ankle pumps + calf isometrics","2×20, hourly early (circulation)","→ seated calf raises")],
  motion:[X("Stationary bike","5–15 min, daily","↑ time, then ↑ resistance"),
    X("Mini-squat / wall sit","3×30–45s, 4×/wk","↑ depth pain-free → ↑ hold → add load"),
    X("Low step-ups","3×8–10, 3×/wk","↑ step height → add dumbbells"),
    X("Terminal knee extension (band)","3×12","↑ band tension"),
    X("Single-leg balance (eyes open→closed→foam)","3×30s","↑ instability + reach / light perturbation")],
  strength:[X("Goblet squat / leg press","3–4×8–12, tempo 3-1-1","+5–10% load at top of range with 2 reps in reserve"),
    X("Bulgarian split squat / step-down","3×8–10 /side","↑ range → add DBs"),
    X("Hamstring curl → Nordic progression","3×6–10","band-assisted → full Nordic eccentrics"),
    X("Single-leg RDL","3×8 /side","↑ load and range"),
    X("Hip abductor + calf raise","3×12","BW → single-leg → loaded")],
  advanced:[X("Jump-landing & deceleration (drop-and-stick)","3×5, 2×/wk","double → single leg → ↑ height → add cut"),
    X("Hop battery (single / triple / crossover)","3×3–5 /side","↑ distance & quality toward LSI ≥90%"),
    X("Change-of-direction / agility → cutting","quality reps, 2×/wk","↑ speed → unanticipated cuts"),
    X("Plyometric loading (bounds, depth jumps)","low volume, high quality","↑ intensity as tolerated (capacity-gated)"),
    X("Sport-specific reactive drills","graded","build to full-speed sport demand")]},
 rts:["Quad & hamstring strength LSI ≥90%","Single/triple/crossover hop LSI ≥90%","Sound landing mechanics (low LESS)","ACLR: ACL-RSI ≥56 and criterion-based clearance ~≥9 mo"],
 heal:"After ACL reconstruction, published courses run ~9–12 months to sport; meniscus/cartilage repair protects loading longer. Surgeon's weight-bearing/ROM limits govern the early phase.",
 flags:["Locking, giving-way, or a new pop with loss of function","Rapid large effusion or inability to bear weight","Calf swelling/warmth/pain (possible clot, esp. post-op)"]},

shoulder:{name:"Shoulder",
 pools:{
  protect:[X("Pendulums + scapular sets","3×10, daily (in sling as allowed)","→ active-assisted ROM"),
    X("Passive / assisted ROM in allowed arcs","2×10 flexion/ER, 2×/day","widen arc per protocol"),
    X("Elbow/wrist/hand AROM + grip","2×15 + ball squeezes, daily","maintain distal function"),
    X("Sub-max cuff isometrics at neutral","5×15s each direction","→ light banded isotonics")],
  motion:[X("Active-assisted flexion/ER (cane, pulley)","3×10","→ active ROM as pain allows"),
    X("Table slides / wall walks","3×8","↑ reach height weekly"),
    X("Scapular control (serratus, lower trap)","3×10","↑ load/lever"),
    X("Rhythmic stabilization (light)","3×20s","↑ perturbation")],
  strength:[X("Banded IR/ER (progressive)","3×12–15","light → heavier band → cable/DB"),
    X("Scapular strengthening (rows, prone Y/T/W)","3×10–12","↑ load, ↑ lever"),
    X("Closed-chain (wall/quadruped → push-up plus)","3×10","↑ instability & load"),
    X("Progressive press & pull in available range","3×8–12","↑ load 5–10% at criteria"),
    X("Cuff endurance (side-lying ER, prone)","2×15","↑ reps then load")],
  advanced:[X("Plyometric ball drills (chest, overhead)","3×8, 2×/wk","↑ speed & load"),
    X("Overhead & loaded functional patterns","3×8","↑ load and range"),
    X("Interval throwing / serving progression","per throwing program","↑ distance/intensity per milestones"),
    X("Eccentric & rate-of-loading for demand","3×6","↑ velocity as tolerated")]},
 rts:["Full pain-free ROM & symmetric scapular control","Cuff & scapular strength ≥90% of uninvolved side","Sport loading (e.g., interval throwing) symptom-free","No night pain or apprehension under load"],
 heal:"After rotator-cuff repair: sling + passive early, active motion ~6 wk, strengthening ~3 mo, full strength 6–12 mo; larger/retracted tears slower. Surgeon sets the pace.",
 flags:["Fever, wound drainage, spreading redness (infection)","Sudden loss of active elevation after a jerk (possible re-tear)","Progressive arm numbness/weakness"]},

ankle:{name:"Ankle / foot",
 pools:{
  protect:[X("Protected weight-bearing / brace as advised","per protocol","wean support as stability returns"),
    X("Ankle pumps & alphabet (pain-free)","3×20, several×/day","widen range"),
    X("4-way isometrics (inv/ev/DF/PF)","5×15s each","→ banded isotonics"),
    X("Elevation + compression (edema)","as needed","taper as swelling resolves")],
  motion:[X("Weight-bearing dorsiflexion (knee-to-wall)","3×10","↑ range"),
    X("Seated → standing heel raises","3×12","→ single-leg"),
    X("Single-leg balance (open→closed→foam)","3×30s","↑ instability + perturbation"),
    X("Gait normalization on level ground","daily practice","→ uneven surfaces")],
  strength:[X("Banded 4-way ankle","3×15","↑ band tension"),
    X("Heel-raise loading (bilateral→single)","3×12","add load → single-leg → deficit range"),
    X("Balance on unstable surface","3×45s","↑ difficulty + tasks"),
    X("Posterior-chain & hip control","3×10","↑ load"),
    X("Calf endurance (single-leg to fatigue)","2×max","track reps toward symmetry")],
  advanced:[X("Hopping & landing progressions","3×6, 2×/wk","double→single, ↑ height"),
    X("Lateral bounding & multidirectional agility","quality reps","↑ speed & distance"),
    X("Running progression (straight→cut)","graded intervals","↑ volume then change-of-direction"),
    X("Reactive sport-specific change-of-direction","graded","build to full speed")]},
 rts:["Full ROM & single-leg balance symmetry","Single-leg heel-raise endurance & hop LSI ≥90%","Agility / cutting pain-free at speed","Confidence on the involved limb under load"],
 heal:"Lateral ankle sprains do better with early functional loading + balance than immobilization for most grades. Post-op / fracture follows the surgeon's weight-bearing schedule.",
 flags:["Inability to bear weight or bony point tenderness (rule out fracture)","Calf swelling/warmth/pain (possible clot)","Numbness, cold foot, or poorly controlled swelling"]},

lumbar:{name:"Lower back (lumbar)",
 pools:{
  protect:[X("Directional-preference movements (often extension or flexion bias)","10 reps every 2–3 h","follow the direction that centralizes symptoms"),
    X("Diaphragmatic breathing + gentle nerve glides","2–3×/day","progress glide range if radicular"),
    X("Frequent walking (avoid bed rest)","short, frequent bouts","↑ duration daily"),
    X("Symptom-eased positions & pacing","as needed","reduce reliance as pain settles")],
  motion:[X("Cat-camel + hip-hinge patterning","2×10","groove neutral-spine hinge"),
    X("Core motor control: dead-bug, bird-dog","3×8 /side","↑ lever & load"),
    X("Side-plank progression","3×20–30s","↑ time → add movement"),
    X("Hip mobility (flexors, rotators)","2×/day","restore hip range to offload spine"),
    X("Graded walking program","daily, ↑ distance","→ light jogging if a goal")],
  strength:[X("Hip hinge (RDL, kettlebell) with control","3×8–10","↑ load at criteria"),
    X("Squat / carry patterns","3×8 + carries 3×20 m","↑ load"),
    X("Trunk endurance (McGill big-3 progression)","3 sets, timed","↑ hold/reps"),
    X("Glute & posterior-chain strengthening","3×10","↑ load"),
    X("Anti-rotation (Pallof, chops)","3×10","↑ resistance")],
  advanced:[X("Loaded lifting to task demand (deadlift progression)","3×5","↑ load to occupational/sport need"),
    X("Rotational & anti-rotation power","3×6","↑ velocity"),
    X("Work/sport simulation (lift, carry, twist)","task-specific","↑ load & complexity"),
    X("Graded exposure to feared movements","progressive","reduce fear-avoidance, ↑ confidence")]},
 rts:["Tolerates task/sport loading (lift, carry, rotate) without flare","Restored trunk endurance & hip strength","Graded exposure completed for painful movements","Low fear-avoidance / confidence restored"],
 heal:"Most non-specific low-back pain improves with staying active, graded loading, and reassurance; imaging often doesn't match symptoms. Worsening leg symptoms warrant review.",
 flags:["Saddle numbness, new bladder/bowel change, progressive leg weakness (possible cauda equina — EMERGENCY)","Unrelenting night pain, unexplained weight loss, or fever","New/worsening leg numbness or weakness"]},

hip:{name:"Hip / groin",
 pools:{
  protect:[X("Pain-free hip ROM in allowed range","2×10, daily","widen range"),
    X("Adductor/abductor isometric squeezes (submax)","5×15s","↑ effort as pain-free"),
    X("Glute activation (bridges, clams)","3×12","↑ load/band"),
    X("Gait & posture normalization","daily","reduce compensations")],
  motion:[X("Hip mobility (flexor, rotator) drills","2×/day","restore full range"),
    X("Bridging & banded hip series","3×12","↑ band → single-leg"),
    X("Balance & single-leg stance","3×30s","↑ instability"),
    X("Copenhagen adductor (intro, short lever)","3×6","→ long lever")],
  strength:[X("Copenhagen adductor progression","3×6–10","short → long lever, ↑ reps"),
    X("Hip abductor / thrust","3×10","↑ load"),
    X("Split squat / single-leg RDL","3×8 /side","↑ load & range"),
    X("Progressive squat/deadlift patterns","3×8","↑ load at criteria"),
    X("Pelvic control under load (carries)","3×20 m","↑ load")],
  advanced:[X("Change-of-direction & cutting mechanics","quality reps","↑ speed"),
    X("Kicking / sprint progression (as relevant)","graded","↑ intensity per milestones"),
    X("Reactive multidirectional agility","graded","↑ complexity"),
    X("Sport-specific power & deceleration","graded","full-speed demand")]},
 rts:["Adductor & abductor strength symmetry (e.g., squeeze test)","Single-leg control & change-of-direction tolerance","Sport loading (sprint/kick/cut) symptom-free","No pain with resisted adduction"],
 heal:"Groin/adductor pain responds to progressive adductor loading (Copenhagen-style). Post-op hip (labral/FAI) follows the surgeon's weight-bearing/ROM limits.",
 flags:["Deep groin pain with night pain or inability to bear weight (rule out hip/femoral-neck pathology)","Numbness/tingling into the leg","Post-op infection signs"]},

hamstring:{name:"Hamstring / thigh",
 pools:{
  protect:[X("Pain-free inner-range isometric holds","5×15–30s","↑ hold/effort as pain-free"),
    X("Gentle ROM & walking in tolerance","daily","↑ range"),
    X("Avoid aggressive early stretching","—","protect the healing muscle"),
    X("Edema control if acute","as needed","taper")],
  motion:[X("Isometrics → light isotonic curls","3×10","↑ load"),
    X("Hip-hinge patterning & glute work","3×10","groove hinge, ↑ load"),
    X("Bridges / single-leg extensor control","3×10","→ single-leg"),
    X("Low-speed treadmill / bike","10–15 min","↑ speed gradually")],
  strength:[X("Eccentric loading (Nordic progression)","3×6","band-assisted → full Nordic"),
    X("Lengthened-position loading (Askling-style)","3×8","↑ range & load"),
    X("RDL / single-leg RDL","3×8","↑ load & range"),
    X("Hip & trunk control","3×10","↑ load"),
    X("Hamstring endurance","2×15","↑ reps then load")],
  advanced:[X("High-speed running program (graded)","interval progression","↑ % max-speed weekly"),
    X("Acceleration/deceleration & sprint mechanics","quality reps","↑ intensity"),
    X("Reactive running & cutting","graded","↑ complexity"),
    X("Maximal sprinting tolerance","before clearance","achieve full-speed symptom-free")]},
 rts:["Strength symmetry including at length (eccentric)","Pain-free maximal-sprint progression completed","No apprehension on lengthening loads (e.g., Askling H-test)","Full ROM restored"],
 heal:"Hamstring strains benefit from early protected loading and training the muscle at length (eccentric/lengthened). Rushing high-speed running is a leading re-injury cause.",
 flags:["Palpable gap, severe bruising to the knee, or inability to contract (possible full tear)","Numbness/weakness (nerve involvement)","Persistent high proximal pain (possible tendon avulsion)"]},

calf:{name:"Calf / Achilles",
 pools:{
  protect:[X("Isometric plantarflexion holds (pain-guided)","5×30–45s","↑ effort as pain settles"),
    X("Protected weight-bearing / heel lift as advised","per protocol","wean support"),
    X("Ankle ROM within comfort","2×10","widen range"),
    X("Load management (reduce spring-like load)","—","reintroduce load progressively")],
  motion:[X("Bilateral heel raises (seated→standing)","3×12","→ single-leg"),
    X("Progressive calf loading through range","3×12","↑ range & load"),
    X("Balance & gait normalization","3×30s","↑ instability"),
    X("Ankle dorsiflexion mobility","2×10","restore range")],
  strength:[X("Heavy-slow resistance calf raise (straight & bent knee)","3×8, tempo 3-0-3","progress ~15RM→6RM over ~12 wk"),
    X("Single-leg heel-raise progression","3×10","add load → deficit range"),
    X("Posterior-chain & hip strengthening","3×10","↑ load"),
    X("Soleus-biased seated raise","3×12","↑ load"),
    X("Calf endurance to fatigue","2×max","track toward symmetry")],
  advanced:[X("Hopping & pogo progressions (energy storage)","3×10, alt days","↑ height & stiffness"),
    X("Skipping / bounding","quality reps","↑ distance & speed"),
    X("Running progression (straight→cut)","graded","↑ volume then agility"),
    X("Reactive sport-specific plyometrics","graded","full demand")]},
 rts:["Single-leg heel-raise endurance & height symmetry","Hop/bound symmetry ≥90%","Running & reactive loading pain-free","24-hour pain response acceptable at each step"],
 heal:"Achilles tendinopathy follows the staged loading model (isometric→HSR→energy storage→return). Achilles rupture/repair is a separate, longer, surgeon-directed course with protected plantarflexion early.",
 flags:["Sudden 'kicked in the calf' pop with weak push-off (possible rupture — urgent)","Calf swelling/warmth/pain (possible clot)","Night pain or rapidly worsening symptoms"]},

elbow:{name:"Elbow",
 pools:{
  protect:[X("Pain-free elbow/wrist ROM in allowed range","2×10","widen range"),
    X("Grip & forearm isometrics (submax)","5×15s","↑ effort"),
    X("Protect healing structures per protocol","—","advance per timeline"),
    X("Edema control","as needed","taper")],
  motion:[X("Progressive flexion/extension & forearm rotation","3×10","↑ range"),
    X("Light wrist/forearm strengthening","3×12","↑ load"),
    X("Scapular & shoulder base work","3×10","↑ load"),
    X("Nerve glides if indicated","gentle, 2×/day","↑ range")],
  strength:[X("Forearm/wrist & grip loading","3×12","↑ load"),
    X("Eccentric wrist work (epicondylalgia)","3×15 slow","↑ load"),
    X("Shoulder & scapular strengthening","3×10","↑ load"),
    X("Progressive loading to task demand","3×8","↑ load at criteria"),
    X("Forearm endurance","2×15","↑ reps")],
  advanced:[X("Plyometric & rhythmic stabilization","3×8","↑ speed"),
    X("Interval throwing / racquet progression","per program","↑ per milestones"),
    X("Rate-of-loading & sport patterns","3×6","↑ velocity"),
    X("Return-to-throw milestones (UCL/throwers)","staged","complete throwing program")]},
 rts:["Full pain-free ROM & grip/forearm strength symmetry","Loading/throwing progression symptom-free","Scapular & shoulder base restored","No pain with valgus/sport loading"],
 heal:"Epicondylalgia responds to progressive eccentric/loaded forearm work. UCL reconstruction (Tommy John) is a long, staged, surgeon- and throwing-program-directed course.",
 flags:["Hand numbness/tingling (nerve involvement)","Locking or a hard block to motion","Post-op infection signs"]},

cervical:{name:"Neck (cervical)",
 pools:{
  protect:[X("Pain-free active ROM all planes","5–10 reps, several×/day","widen range"),
    X("Deep-neck-flexor activation (chin nods)","3×10","↑ hold"),
    X("Postural & breathing resets","hourly","reduce static loading"),
    X("Gentle nerve glides if radicular","2×/day","↑ range carefully")],
  motion:[X("Cervical & thoracic mobility","2×10","↑ range"),
    X("Scapular & postural endurance","3×10","↑ time/load"),
    X("Multi-directional isometric neck","5×15s","↑ effort"),
    X("Graded screen/desk tolerance","timed bouts","↑ duration")],
  strength:[X("Progressive neck & scapular strengthening","3×12","↑ load"),
    X("Thoracic extension & postural loading","3×10","↑ load"),
    X("Upper-back & shoulder strengthening","3×10","↑ load"),
    X("Sustained-posture endurance","timed","↑ duration")],
  advanced:[X("Load & task-specific endurance","task-specific","↑ demand"),
    X("Contact/impact tolerance (if relevant)","graded","↑ exposure"),
    X("Reactive & sport-specific patterns","graded","full demand")]},
 rts:["Full pain-free ROM & neck/scapular endurance","Tolerance of sustained work/sport postures","No arm symptoms under load","Confidence with provocative positions"],
 heal:"Most mechanical neck pain and whiplash improve with early gentle motion, deep-neck-flexor and postural work, and reassurance rather than rest/collars.",
 flags:["Arm weakness/numbness, gait or hand-coordination change (possible cord/nerve involvement — urgent)","Severe pain after major trauma (rule out fracture first)","Dizziness, visual changes, or drop attacks"]},

wrist:{name:"Wrist / hand",
 pools:{
  protect:[X("Pain-free wrist/hand ROM in allowed range","2×10","widen range"),
    X("Tendon glides & edema control","3×10, daily","maintain glide"),
    X("Grip isometrics (submax)","5×15s","↑ effort"),
    X("Protect fracture/repair per protocol","—","advance per timeline")],
  motion:[X("Progressive flexion/extension & forearm rotation","3×10","↑ range"),
    X("Grip & pinch progression (light)","3×12","↑ resistance"),
    X("Intrinsic hand strengthening","3×12","↑ resistance"),
    X("Functional task practice","daily","↑ complexity")],
  strength:[X("Progressive grip/wrist loading","3×12","↑ load"),
    X("Forearm eccentric work","3×15 slow","↑ load"),
    X("Kinetic-chain (elbow/shoulder) support","3×10","↑ load"),
    X("Load to occupational/sport demand","3×8","↑ load")],
  advanced:[X("Weight-bearing & impact tolerance (as relevant)","graded","↑ load"),
    X("Sport-specific loading (racquet/bar/stick)","graded","↑ intensity"),
    X("Rate-of-loading progression","3×6","↑ velocity")]},
 rts:["Full ROM & grip/pinch strength symmetry","Task/sport loading pain-free","No swelling flare after loading","Confidence with weight-bearing if sport needs it"],
 heal:"Wrist/hand fractures follow bone-healing timelines (weeks of protection before loading), then progressive ROM and strengthening set by the treating clinician.",
 flags:["Increasing swelling, deformity, or inability to move digits (rule out fracture/tendon injury)","Numbness/tingling (nerve compression)","Post-op infection signs"]},

general:{name:"General / other region",
 pools:{
  protect:[X("Pain-free active movement of the region","2×10","widen range"),
    X("Local isometric activation (submax)","5×15s","↑ effort"),
    X("Load & activity management","—","reintroduce load progressively"),
    X("Swelling/pain basic measures","as needed","taper")],
  motion:[X("Progressive ROM & mobility","2×10","↑ range"),
    X("Motor-control & activation drills","3×10","↑ complexity"),
    X("Balance & general conditioning","3×30s","↑ difficulty"),
    X("Graded return to daily movement","daily","↑ demand")],
  strength:[X("Progressive strengthening of the area","3×10","↑ load"),
    X("Adjacent-joint / kinetic-chain work","3×10","↑ load"),
    X("Endurance & control under load","2×15","↑ reps/load"),
    X("Task-specific loading","3×8","↑ demand")],
  advanced:[X("Power / plyometric where appropriate","graded","↑ intensity"),
    X("Sport/task-specific patterns","graded","full demand"),
    X("Reactive & rate-of-loading work","graded","↑ complexity")]},
 rts:["Symmetric strength & full ROM restored","Tolerates the target activity without flare","Good movement quality under load","Confidence at full effort"],
 heal:"Progress is criterion-based: advance when the tissue tolerates the current load without a lasting flare, guided by your clinician.",
 flags:["Severe unremitting or night pain","Fever, spreading redness, wound drainage (infection)","New numbness, weakness, or loss of function"]}
};

/* ===================== PHASE MODELS ===================== */
export function phaseModel(nature){const M={
 postsurg:[
  {kind:"protect",nm:"Protect & Heal",pool:"protect",wk:[0,6],goal:"Protect the repair/graft, control pain & swelling, restore protected motion and activation within the surgeon's limits.",prec:"Follow the surgeon's weight-bearing and ROM restrictions exactly — healing tissue is vulnerable now.",crit:["Pain & swelling controlled","Protected-range ROM targets met","Good muscle activation","Surgeon clearance to advance"]},
  {kind:"motion",nm:"Restore Motion & Activation",pool:"motion",wk:[6,12],goal:"Regain full active range, normalize movement/gait, re-establish neuromuscular control.",prec:"Advance range/activity as pain and protocol allow; no sharp pain or swelling flares.",crit:["Full/near-full pain-free ROM","Normalized gait / movement","Minimal pain with daily tasks"]},
  {kind:"strength",nm:"Progressive Strengthening",pool:"strength",wk:[12,24],goal:"Progressively load tissue to rebuild strength, endurance, control.",prec:"Increase load gradually; lasting pain/swelling means back off.",crit:["Strength symmetry toward ≥70–80%","Full ROM under load","No lasting flare with progression"]},
  {kind:"advanced",nm:"Advanced Loading & Return",pool:"advanced",wk:[24,52],goal:"Restore power, reactive capacity, sport/task demands; pass return criteria.",prec:"Return is criterion-based and clinician-cleared, not calendar-based.",crit:["Return battery passed","Confidence & symmetry at full effort","Clinician clearance"]}],
 acute:[
  {kind:"protect",nm:"Acute Protection (PEACE)",pool:"protect",wk:[0,1],goal:"Protect, control pain/swelling, keep gentle pain-free motion — avoid full rest and over-reliance on anti-inflammatories.",prec:"Protect from further harm; load optimally within pain-free limits.",crit:["Pain trending down","Swelling controlled","Gentle motion without sharp pain"]},
  {kind:"motion",nm:"Restore Motion & Early Loading (LOVE)",pool:"motion",wk:[1,3],goal:"Restore range, begin loading, rebuild confidence with graded activity.",prec:"Use pain as a guide — mild settling discomfort OK; sharp/lasting pain is not.",crit:["Full/near-full pain-free ROM","Loads for daily tasks","Confidence improving"]},
  {kind:"strength",nm:"Progressive Strengthening & Control",pool:"strength",wk:[3,8],goal:"Rebuild strength, endurance, neuromuscular control toward the demands ahead.",prec:"Progress load steadily; watch for flares lasting >24 h.",crit:["Strength approaching symmetry","Good control under load","No lasting flares"]},
  {kind:"advanced",nm:"Return to Activity / Sport",pool:"advanced",wk:[8,16],goal:"Reintroduce speed/power/sport demand via graded exposure; meet return criteria.",prec:"Graded exposure — don't skip reactive/speed stages.",crit:["Return criteria met","Full-effort tolerance without flare","Confidence restored"]}],
 tendino:[
  {kind:"protect",nm:"Isometrics & Load Management",pool:"protect",wk:[0,3],goal:"Modulate pain with isometric loading, reduce aggravating spring-like loads, keep the tendon working.",prec:"Tolerable pain during loading is OK; it should settle to baseline within 24 h. Avoid full rest.",crit:["Day-to-day pain more controlled","24-hour response acceptable","Ready for heavier slow loading"]},
  {kind:"strength",nm:"Heavy-Slow Resistance",pool:"strength",wk:[3,9],goal:"Build tendon & muscle capacity with heavy-slow resistance — slow tempo, toward ~6RM, ~3×/wk with 48 h between.",prec:"Load through tolerable discomfort; track the 24-hour rule each step.",crit:["Strength & load tolerance rising","Pain low and stable","Symmetry improving"]},
  {kind:"advanced",nm:"Energy Storage & Plyometric",pool:"advanced",wk:[9,14],goal:"Add faster spring-like loading (hop/bound/plyometric) to store and release energy.",prec:"Alternate days with strength work; respect the 24-hour rule.",crit:["Tolerates energy-storage loading","No lasting flares","Approaching sport demands"]},
  {kind:"advanced",nm:"Return to Sport & Maintain",pool:"advanced",wk:[14,24],goal:"Graded return to sport demands + a maintenance strength dose to prevent recurrence.",prec:"Keep 1–2 heavy-slow sessions/wk ongoing — tendons recur without maintenance load.",crit:["Full sport loading tolerated","Symmetry restored","Maintenance habit established"]}],
 fracture:[
  {kind:"protect",nm:"Protected Healing",pool:"protect",wk:[0,6],goal:"Protect the bone per the treating clinician while keeping adjacent joints moving.",prec:"Respect the bone-healing protection period exactly; move joints above/below as allowed.",crit:["Clinician confirms adequate bony healing","Adjacent joints mobile","Pain controlled"]},
  {kind:"motion",nm:"Restore Motion",pool:"motion",wk:[6,10],goal:"After clearance, restore range and normalize movement of involved & adjacent joints.",prec:"Motion/light loading only once the clinician clears bone healing.",crit:["Restoring pain-free ROM","Normalizing movement","No site pain with gentle load"]},
  {kind:"strength",nm:"Progressive Strengthening",pool:"strength",wk:[10,18],goal:"Rebuild strength and loading tolerance of the deconditioned area.",prec:"Progress load gradually; monitor the healed site.",crit:["Strength approaching symmetry","Full ROM under load","No site pain with loading"]},
  {kind:"advanced",nm:"Return to Function / Sport",pool:"advanced",wk:[18,32],goal:"Restore power and impact/sport tolerance; meet return criteria.",prec:"Reintroduce impact gradually; criterion-based return.",crit:["Return criteria met","Impact tolerance restored","Confidence at full effort"]}],
 decon:[
  {kind:"motion",nm:"Reduce Symptoms & Restore Movement",pool:"motion",wk:[0,3],goal:"Calm symptoms, restore basic pain-free movement, re-establish a daily activity baseline.",prec:"Stay active within comfort; avoid the boom-bust cycle.",crit:["Symptoms more controlled","Baseline daily movement restored","Ready for progressive loading"]},
  {kind:"strength",nm:"General Strengthening & Motor Control",pool:"strength",wk:[3,8],goal:"Build foundational strength, endurance, and movement quality.",prec:"Consistency over intensity here.",crit:["Strength & endurance improving","Good movement control","Confident with daily loads"]},
  {kind:"strength",nm:"Progressive Loading & Capacity",pool:"strength",wk:[8,14],goal:"Increase loading and work capacity toward goals.",prec:"Advance load as tolerated; keep it sustainable.",crit:["Meeting strength targets","Higher work capacity","No lasting flares"]},
  {kind:"advanced",nm:"Function, Performance & Prevention",pool:"advanced",wk:[14,24],goal:"Add power/higher-level function as appropriate; lock in prevention.",prec:"Match intensity to capacity tier; keep a maintenance routine.",crit:["Goal function achieved","Prevention routine established","Independent progress"]}]
};return M[nature]||M.acute;}

export const NORM_GRIP={ // [lo, med, hi]
 m:{teen:[26,33,40],"20s":[42,50,58],"30s":[40,48,56],"4050s":[37,45,53],"60s":[32,40,48],"70s":[26,33,40]},
 f:{teen:[18,24,30],"20s":[25,31,37],"30s":[24,30,36],"4050s":[22,28,34],"60s":[20,25,30],"70s":[15,20,25]}};
/* 30-sec chair stand (reps) — Rikli-Jones normal range [lo,hi] (below lo = below average). */
export const NORM_CHAIR={ m:{"60s":[13,18],"70s":[11,17]}, f:{"60s":[11,16],"70s":[10,15]} };
/* Comfortable gait speed (m/s) — approx mean by age/sex (Bohannon synthesis). Clinical: <1.0 adverse, <0.8 frailty. */
export const NORM_GAIT={ m:{"20s":1.39,"30s":1.43,"4050s":1.43,"60s":1.34,"70s":1.20}, f:{"20s":1.34,"30s":1.34,"4050s":1.35,"60s":1.24,"70s":1.13} };

/* Expected quadriceps strength LSI (%) trajectory after limb surgery/serious injury, by months.
   From ACLR literature: little change <3 mo; ~1 in 5 reach full symmetry by 6 mo; ~half by 12 mo. */
export function expLSI(months){
  const pts=[[0,45,52,60],[1.5,48,55,63],[3,55,64,73],[4,62,70,80],[6,72,82,90],[9,82,89,95],[12,86,92,98],[18,90,95,100]];
  let a=pts[0],b=pts[pts.length-1];
  for(let i=0;i<pts.length-1;i++){ if(months>=pts[i][0]&&months<=pts[i+1][0]){a=pts[i];b=pts[i+1];break;} }
  if(months>=pts[pts.length-1][0]) a=b=pts[pts.length-1];
  const t=(b[0]===a[0])?0:(months-a[0])/(b[0]-a[0]);
  const it=(i)=>Math.round(a[i]+t*(b[i]-a[i]));
  return {lo:it(1),med:it(2),hi:it(3)};
}
export const P90= "≥90% is the common clearance benchmark; only ~1 in 5 people reach full symmetry by 6 months and ~half by 12.";

export function poolFor(R,phase,custom){
  const base=(R.pools[phase.pool]||R.pools.motion).slice();
  const add=custom.filter(c=>c.phase===phase.kind||c.phase==="all"||c.phase===phase.pool)
    .map(c=>({n:c.n,d:c.d||"as directed",p:"per clinician",cl:true}));
  return base.concat(add);
}

/* per-week dosing ramp within a phase */
function weekDose(D,phaseKind,wkInPhase,deload,nature){
  let sets=D.setsN;
  if(wkInPhase===0)sets=Math.max(1,D.setsN-1);      // reintroduce
  if(deload)sets=Math.max(1,D.setsN-1);
  const reps=D.reps;
  let cue;
  if(deload)cue="Deload — hold load, drop a set, prioritize quality & recovery.";
  else if(wkInPhase===0)cue="Phase entry — reintroduce movements at the low end, confirm tolerance.";
  else cue=`Progress — ${D.progr}.`;
  return {sets,reps,cue};
}

export function buildWeeks({phases,R,D,cap,nature,region,goals,ageB,days,totalWk,custom,athlete}){
  const isOlder=["60s","70s"].includes(ageB);
  const wantBalance=goals.includes("balance")||isOlder||["knee","ankle","hip"].includes(region);
  const wantPower=(goals.includes("power")||["hs","college","pro"].includes(athlete));
  const out=[];
  const phaseAt=w=>{for(const p of phases){if(w>=p.adjWk[0]+1&&w<=p.adjWk[1])return p;}return w<=phases[0].adjWk[1]?phases[0]:phases[phases.length-1];};
  for(let w=1;w<=totalWk;w++){
    const p=phaseAt(w);
    const wkInPhase=w-(p.adjWk[0]+1);
    const deload=(w%4===0);
    const wd=weekDose(D,p.kind,Math.max(0,wkInPhase),deload,nature);
    const pool=poolFor(R,p,custom);
    const blocks=[];

    // mobility / movement prep — daily
    const mob=(R.pools.protect.slice(0,2)).concat(R.pools.motion.slice(3,4));
    blocks.push({t:"Mobility / movement prep",note:"daily · 8–12 min",kind:"mob",items:mob});

    // main phase block
    let mainNote;
    if(p.pool==="protect")mainNote=`${D.freq}×/wk · gentle, pain-guided`;
    else if(p.pool==="strength"&&nature==="tendino")mainNote="3×/wk (48 h apart) · slow tempo, progress toward 6RM";
    else if(p.pool==="strength")mainNote=`${wd.sets} sets × ${wd.reps} · ${D.freq}×/wk`;
    else if(p.pool==="advanced")mainNote=`${Math.max(2,D.freq-1)}×/wk · quality over volume`;
    else mainNote=`${wd.sets} sets × ${wd.reps} · ${D.freq}×/wk`;
    blocks.push({t:p.nm+" — main work",note:mainNote,kind:"main",items:pool});

    // neuromuscular / balance
    if(wantBalance && p.kind!=="protect"){
      const bal=[X("Single-leg balance (open→closed→foam)",`3×30s · ${Math.max(2,D.freq-1)}×/wk`,"↑ instability, add reach/perturbation")];
      if(isOlder||goals.includes("balance"))bal.push(X("Reactive / perturbation balance","3×/wk","step/reach reactions → uneven ground (fall-prevention)"));
      blocks.push({t:"Neuromuscular & balance",note:"",kind:"bal",items:bal});
    }
    // power / plyometric — advanced phase
    if(p.pool==="advanced"){
      if(D.plyo && wantPower){
        blocks.push({t:"Power & plyometric",note:`${Math.max(2,D.freq-1)}×/wk · low volume, max quality`,kind:"pow",items:R.pools.advanced.filter(x=>/plyo|hop|bound|jump|sprint|reactive|throw/i.test(x.n)).slice(0,3)});
      } else {
        blocks.push({t:"Controlled power (capacity-modified)",note:"2×/wk",kind:"pow",items:[X("Fast-concentric strength reps (light-moderate)","3×5, move fast","aids function & fall resilience"),X("Low-impact bounding / step-downs","quality reps","↑ impact only as tolerated")]});
      }
    }
    // RTS testing in advanced
    if(p.pool==="advanced"){
      blocks.push({t:"Return-gate testing",note:"every ~2–3 wk",kind:"rts",items:R.rts.map(c=>X(c,"test & log","must clear before full return"))});
    }
    // monitoring
    const mon=[X("Symptom & load log","daily","mild settling discomfort OK; sharp/lasting pain = back off")];
    if(nature==="tendino")mon.push(X("24-hour tendon pain rule","each session","pain must return to baseline within 24 h before adding load"));
    mon.push(X("Deload every 4th week","—","reduce volume, keep the habit, let tissue adapt"));
    blocks.push({t:"Monitoring & recovery",note:"",kind:"mon",items:mon});

    // gate note if this is the first week of a new phase (except phase 1)
    const phaseIdx=phases.indexOf(p);
    const gate=(wkInPhase===0&&phaseIdx>0)?phases[phaseIdx-1].crit:null;

    out.push({week:w,phaseName:p.nm,phaseIdx,focus:wd.cue,deload,blocks,gate,gateFrom:gate?phases[phaseIdx-1].nm:null});
  }
  return out;
}

/* ===================== analyses (history/goals) ===================== */
export function historyAnalysis(hist,region){
  const n=[];
  if(hist.includes("samesurg")||hist.includes("samesite"))n.push({k:"Elevated re-injury risk (same site)",v:"Prior injury/surgery at this site is among the strongest re-injury predictors. Hold return criteria to the strict end (≥90% symmetry AND movement quality AND psychological readiness) and don't shortcut the reactive/late phases."});
  if(hist.includes("recurrent"))n.push({k:"Recurrent pattern",v:"Points to an unaddressed capacity or load-management gap. Build in an ongoing maintenance dose and progress total load conservatively."});
  if(hist.includes("otherlower")&&["knee","ankle","hip","hamstring","calf"].includes(region))n.push({k:"Prior lower-limb injury",v:"Screen the whole limb and the opposite side — compensations often feed lower-limb re-injury; symmetry targets should account for deficits on the 'good' side too."});
  if(hist.includes("back")&&["hip","hamstring","lumbar"].includes(region))n.push({k:"Prior back injury",v:"Back and hip/hamstring problems interact — keep trunk motor-control and hip work in the plan, not just local exercises."});
  if(hist.includes("none")||n.length===0)n.push({k:"No major history flags",v:"No prior-injury risk multipliers entered. Still build a prevention/maintenance habit into the final phase."});
  return n;
}
export function goalEmphasis(goals,ageB,cap,D,athlete){
  const b=[],isOlder=["60s","70s"].includes(ageB);
  if(goals.includes("balance")||isOlder)b.push({k:"Balance & fall prevention",v:"Progressive balance and reactive/perturbation training reduce fall risk; pair with fast-concentric power reps — power (not just strength) drives daily function and fall resilience in older adults. Included from early phases in the weekly plan."});
  if(goals.includes("power")||["hs","college","pro"].includes(athlete))b.push(D.plyo?{k:"Power & explosiveness",v:"Plyometric and rate-of-loading work is scheduled in the advanced phase once strength symmetry is established."}:{k:"Power — modified",v:"Given the capacity/growth stage, 'power' appears as controlled fast-concentric reps and low-impact bounding rather than high-intensity plyometrics."});
  if(goals.includes("rts")||goals.includes("train"))b.push({k:"Return-to-sport gate",v:"Return is a test to pass, not a date — the weekly plan schedules gate testing in the advanced phase."});
  if(goals.includes("prevent"))b.push({k:"Re-injury prevention",v:"Carry a 1–2×/wk maintenance dose of key strength/control work indefinitely — most re-injuries follow a drop-off in maintenance load after discharge."});
  return b;
}

/* ===================== PLAN (was run() in the source) ===================== */
export const NATURE_NAME = { acute: 'Acute injury (non-surgical)', tendino: 'Chronic / overuse tendinopathy', postsurg: 'Post-surgical', fracture: 'Post-fracture', decon: 'General pain / deconditioning' };

export function buildPlan({ athlete, ageB, region, nature, tsi, pain, irrit, goals, days, horizon, custom }) {
  const cap = capacity(athlete, ageB), D = dosing(cap.tier, ageB), R = REGIONS[region] || REGIONS.general;
  const phases = phaseModel(nature).map(p => ({ ...p, adjWk: [Math.round(p.wk[0] * D.heal), Math.round(p.wk[1] * D.heal)] }));
  let curIdx = 0;
  if (tsi !== null) { curIdx = phases.findIndex(p => tsi < p.adjWk[1]); if (curIdx === -1) curIdx = phases.length - 1; }
  const heldBack = (pain !== null && pain >= 6) || irrit === 'high';
  if (heldBack) curIdx = Math.max(0, curIdx - 1);
  const totalWk = horizon === 'auto' ? Math.max(phases[phases.length - 1].adjWk[1], 8) : parseInt(horizon, 10);
  const weeks = buildWeeks({ phases, R, D, cap, nature, region, goals, ageB, days, totalWk, custom, athlete });
  return { cap, D, R, phases, curIdx, heldBack, totalWk, weeks };
}

export const GENERAL_FLAGS = ['Severe, unremitting, or worsening night pain', 'Fever, spreading redness, or wound drainage (possible infection)', 'Chest pain or shortness of breath — call emergency services'];

/* ===================== CALENDAR SERIALIZATION =====================
   The source plan is week-by-week, not day-by-day. Each week becomes `days`
   sessions on fixed weekdays (Mon = weekday 0, so day_number 1 = Monday and
   the program saves with day_anchor 'weekday', like the other generators).
   Every session carries mobility, the phase's main work, balance and
   monitoring; power work goes on alternate sessions; return-gate testing on
   the last session of every second week of an advanced phase. */
const WEEKDAY_PATTERN = { 3: [0, 2, 4], 4: [0, 1, 3, 4], 5: [0, 1, 2, 3, 4], 6: [0, 1, 2, 3, 4, 5] };
const BLOCK_CATEGORY = { mob: 'recovery', main: 'conditioning', bal: 'conditioning', pow: 'conditioning', rts: 'other', mon: 'recovery' };

export function planToProgramDays(plan, days) {
  const pattern = WEEKDAY_PATTERN[days] || WEEKDAY_PATTERN[4];
  const rows = [];
  plan.weeks.forEach(wk => {
    const ph = plan.phases[wk.phaseIdx];
    const weekInPhase = wk.week - (ph.adjWk[0] + 1);
    pattern.forEach((weekday, si) => {
      const last = si === pattern.length - 1;
      const blocks = wk.blocks.filter(b => {
        if (b.kind === 'pow') return si % 2 === 0;
        if (b.kind === 'rts') return last && weekInPhase % 2 === 1;
        return true;
      });
      let sort = 0;
      const exercises = [];
      blocks.forEach(b => b.items.forEach(x => {
        exercises.push({
          category: BLOCK_CATEGORY[b.kind] || 'other',
          name: x.cl ? `${x.n} (clinician)` : x.n,
          reps: x.d,
          description: [b.t + (b.note ? ` — ${b.note}` : ''), x.p ? `Progression: ${x.p}` : ''].filter(Boolean).join('\n'),
          sort_order: sort++,
        });
      }));
      const notes = [wk.focus];
      if (wk.gate && si === 0) notes.push(`Gate — confirm from "${wk.gateFrom}" before starting this phase:\n• ${wk.gate.join('\n• ')}`);
      rows.push({
        day_number: (wk.week - 1) * 7 + weekday + 1,
        title: `PT · Wk ${wk.week}${wk.deload ? ' (deload)' : ''} · ${wk.phaseName}`,
        notes: notes.join('\n\n'),
        exercises,
      });
    });
  });
  return rows;
}

/* ===================== PROGRESS CHECKS (source §05) =====================
   Same thresholds as the source graders; cls is one of
   ahead|ontrack|behind|good|mid|low|flag|met and `tag` the short pill text. */
export function checkFields(ctx) {
  const lower = ['knee', 'ankle', 'hip', 'hamstring', 'calf'].includes(ctx.region);
  const upper = ['shoulder', 'elbow', 'wrist'].includes(ctx.region);
  const older = ['60s', '70s'].includes(ctx.ageB);
  const F = [{ id: 'week', lab: 'Weeks since injury/surgery', u: 'wk' }, { id: 'pain', lab: 'Pain', u: '0–10' }, { id: 'pro', lab: 'Self-reported function', u: '0–100' }];
  if (lower || upper) { F.push({ id: 'rom', lab: 'ROM restored', u: '% of normal' }); F.push({ id: 'lsi', lab: 'Strength symmetry', u: '% LSI' }); }
  if (lower) F.push({ id: 'hop', lab: 'Single-leg hop symmetry', u: '% LSI' });
  if (ctx.region === 'ankle' || ctx.region === 'calf') F.push({ id: 'heel', lab: 'Heel-raise symmetry', u: '% LSI' });
  if (upper || ctx.region === 'general' || older) F.push({ id: 'grip', lab: 'Grip strength', u: 'kg' });
  if (older || ctx.region === 'general' || lower) { F.push({ id: 'chair', lab: '30-sec chair stands', u: 'reps' }); F.push({ id: 'gait', lab: 'Gait speed', u: 'm/s' }); }
  return F;
}

const gPain = (v) => { const [cls, head] = v <= 1 ? ['good', 'Minimal'] : v <= 3 ? ['mid', 'Mild'] : v <= 5 ? ['low', 'Moderate — modify load'] : ['flag', 'High — this holds phase progression']; return { cls, tag: head.split(' ')[0].toLowerCase(), txt: `${head} pain. Trend matters more than any single reading — it should fall over weeks.` }; };
const gROM = (v) => { const [cls, head, tag] = v >= 95 ? ['good', 'Full / near-full', 'full'] : v >= 85 ? ['mid', 'Near full', 'near'] : ['low', 'Limited', 'limited']; return { cls, tag, gate: v >= 90, txt: `${head} range (${v}% of normal/uninvolved). Restoring motion is an early gate before heavy loading.` }; };
const gLSI = (v, weeks) => {
  if (weeks == null) return { cls: v >= 90 ? 'met' : 'mid', tag: v >= 90 ? 'gate met' : 'developing', gate: v >= 90, txt: P90 };
  const m = weeks / 4.345, e = expLSI(m);
  const [cls, head] = v >= e.hi ? ['ahead', 'Ahead of typical recovery'] : v >= e.lo ? ['ontrack', 'On track for your timepoint'] : ['behind', 'Behind the typical curve'];
  return { cls, tag: cls === 'ontrack' ? 'on track' : cls, gate: v >= 90, txt: `${head}. Typical quad symmetry at ~${m.toFixed(1)} mo is ${e.lo}–${e.hi}% (median ${e.med}%). ${v >= 90 ? '' : P90}` };
};
const gHop = (v) => { const [cls, head] = v >= 90 ? ['met', 'Meets the ≥90% return benchmark'] : v >= 80 ? ['mid', 'Approaching the benchmark'] : ['low', 'Developing']; return { cls, tag: cls === 'met' ? 'gate met' : cls, txt: `${head}. ≥90% hop symmetry is a standard return-to-sport criterion.` }; };
const gHeel = (v) => { const cls = v >= 90 ? 'met' : v >= 80 ? 'mid' : 'low'; return { cls, tag: cls === 'met' ? 'gate met' : cls, txt: `Single-leg heel-raise symmetry ${v}%. Aim ≥90% and matched endurance side-to-side.` }; };
const gGrip = (v, sex, ageB) => {
  const t = NORM_GRIP[sex] && NORM_GRIP[sex][ageB];
  if (!t) return { cls: 'mid', tag: '', txt: 'No age/sex norm available (need sex; pediatric grip varies by size). Track symmetry vs the other hand instead — aim ≥90%.' };
  const [cls, head, tag] = v >= t[2] ? ['good', 'Above average for your age/sex', 'above avg'] : v >= t[0] ? ['mid', 'Around average for your age/sex', 'average'] : ['low', 'Below average for your age/sex', 'below avg'];
  return { cls, tag, txt: `${head}. Typical range ${t[0]}–${t[2]} kg (median ${t[1]}).` };
};
const gChair = (v, sex, ageB) => {
  const t = NORM_CHAIR[sex] && NORM_CHAIR[sex][ageB];
  if (!t) return { cls: 'mid', tag: '', txt: (ageB === '60s' || ageB === '70s') ? 'Need sex for the age norm.' : 'Chair-stand norms are defined for 60+. Younger adults typically do 20+; use as a functional baseline & track your own trend.' };
  const [cls, head, tag] = v > t[1] ? ['good', 'Above the normal range for your age', 'above range'] : v >= t[0] ? ['mid', 'Within the normal range for your age', 'normal'] : ['low', 'Below the normal range — associated with higher fall risk', 'below range'];
  return { cls, tag, txt: `${head}. Normal range ${t[0]}–${t[1]} reps (Rikli-Jones).` };
};
const gGait = (v, sex, ageB) => {
  const med = NORM_GAIT[sex] && NORM_GAIT[sex][ageB];
  let cls, head, tag, extra = '';
  if (v < 0.8) { cls = 'flag'; tag = 'slow'; head = 'Slow — a frailty / adverse-outcome threshold'; extra = ' Discuss with a clinician.'; }
  else if (v < 1.0) { cls = 'low'; tag = 'below'; head = 'Below typical community speed'; }
  else if (med && v >= med) { cls = 'good'; tag = 'typical+'; head = 'At or above typical for your age/sex'; }
  else if (med && v >= med - 0.15) { cls = 'mid'; tag = 'typical'; head = 'Around typical for your age/sex'; }
  else { cls = 'mid'; tag = 'typical'; head = 'Reasonable community speed'; }
  return { cls, tag, txt: `${head}${med ? ` (age/sex median ~${med} m/s)` : ''}.${extra}` };
};
const gPRO = (v, ageB) => { const [cls, head, tag] = v >= 85 ? ['good', 'Good self-reported function', 'good'] : v >= 70 ? ['mid', 'Moderate function', 'moderate'] : ['low', 'Impaired function', 'low']; const old = (ageB === '60s' || ageB === '70s') ? ' Note: normative scores run a little lower at older ages.' : ''; return { cls, tag, txt: `${head} (${v}/100).${old}` }; };

/** entry: { week, pain, rom, lsi, hop, heel, grip, chair, gait, pro } (null = not measured) */
export function gradeCheck(e, ctx) {
  const g = [];
  const lsiWeeks = ['postsurg', 'acute', 'fracture'].includes(ctx.nature) ? (e.week != null ? e.week : ctx.tsi) : null;
  if (e.pain != null) g.push({ metric: 'Pain', value: e.pain, ...gPain(e.pain) });
  if (e.rom != null) g.push({ metric: 'ROM', value: `${e.rom}%`, ...gROM(e.rom) });
  if (e.lsi != null) g.push({ metric: 'Strength LSI', value: `${e.lsi}%`, ...gLSI(e.lsi, lsiWeeks) });
  if (e.hop != null) g.push({ metric: 'Hop LSI', value: `${e.hop}%`, ...gHop(e.hop) });
  if (e.heel != null) g.push({ metric: 'Heel-raise LSI', value: `${e.heel}%`, ...gHeel(e.heel) });
  if (e.grip != null) g.push({ metric: 'Grip', value: `${e.grip} kg`, ...gGrip(e.grip, ctx.sex, ctx.ageB) });
  if (e.chair != null) g.push({ metric: 'Chair stands', value: e.chair, ...gChair(e.chair, ctx.sex, ctx.ageB) });
  if (e.gait != null) g.push({ metric: 'Gait speed', value: `${e.gait} m/s`, ...gGait(e.gait, ctx.sex, ctx.ageB) });
  if (e.pro != null) g.push({ metric: 'Function (PRO)', value: e.pro, ...gPRO(e.pro, ctx.ageB) });
  return g;
}

export function overallRead(grades) {
  const flags = grades.filter(x => x.cls === 'flag').length;
  const behind = grades.filter(x => ['behind', 'low'].includes(x.cls)).length;
  const good = grades.filter(x => ['ahead', 'good', 'met'].includes(x.cls)).length;
  if (flags) return { tone: 'warn', text: 'A reading is in the caution zone — modify load and check in with your clinician before progressing.' };
  if (good >= behind) return { tone: 'good', text: "Overall you're tracking at or ahead of typical recovery for your age and timepoint. Keep progressing through the phase gates — don't skip ahead just because a number looks good." };
  return { tone: 'warn', text: "You're a bit behind the typical curve on some measures. That's common and usually fine — recovery is nonlinear. Hold the current phase, keep loading consistently, and re-test; if it stalls, review with your clinician." };
}

export const CHECK_METRICS = ['pain', 'rom', 'lsi', 'hop', 'heel', 'grip', 'chair', 'gait', 'pro'];
