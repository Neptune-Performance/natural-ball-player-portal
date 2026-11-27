import {
  METRIC_FOCUS, FOCUS_METRIC_KEYS, FOCUS_COUNT, buildFocus, flaggedDeficiencies,
  focusVideoNames, priorityTag, videoKey,
} from './playerFocus';
import { buildPlayerRatings } from './playerRatings';
import { mechanicsDeficiencyInfo } from './mechanicsDeficiencies';

const TODAY = new Date('2026-11-27T12:00:00Z');

// player_rating_inputs() rows: percentile metrics carry a percentile, absolute
// ones only a value.
const pct = (metric_key, value, percentile) => ({ metric_key, value, percentile, cohort: 'hs_under', cohort_n: 40, measured_on: '2026-11-01' });
const abs = (metric_key, value) => ({ metric_key, value, percentile: null, cohort: 'all', cohort_n: 0, measured_on: '2026-11-01' });

describe('config integrity (#496)', () => {
  test('every metric on the card has a focus entry, and nothing extra', () => {
    expect(Object.keys(METRIC_FOCUS).sort()).toEqual([...FOCUS_METRIC_KEYS].sort());
  });

  test('every entry has a goal and at least one drill, check or habit', () => {
    for (const [key, f] of Object.entries(METRIC_FOCUS)) {
      expect(typeof f.goal).toBe('string');
      expect(f.goal.length).toBeGreaterThan(5);
      const n = (f.videos || []).length + (f.checks || []).length + (f.habits || []).length;
      expect([key, n > 0]).toEqual([key, true]);
    }
  });

  test('every mechanical check resolves in the deficiency list, with real drills', () => {
    for (const [key, f] of Object.entries(METRIC_FOCUS)) {
      for (const [area, name] of f.checks || []) {
        const info = mechanicsDeficiencyInfo(area, name);
        expect([key, name, !!info]).toEqual([key, name, true]);
        // Two entries in the PDF only say "see the list" — not usable as a drill.
        expect(info.drills).not.toMatch(/listed|see \d/i);
      }
    }
  });

  test('focusVideoNames is de-duplicated', () => {
    const names = focusVideoNames();
    expect(new Set(names.map(videoKey)).size).toBe(names.length);
    expect(names).toContain('Box Jump');
  });
});

describe('priorityTag', () => {
  test('bands follow the age-group scale (70 = middle)', () => {
    expect(priorityTag(40)).toBe('priority');
    expect(priorityTag(54)).toBe('priority');
    expect(priorityTag(55)).toBe('develop');
    expect(priorityTag(69)).toBe('develop');
    expect(priorityTag(70)).toBe('sharpen');
    expect(priorityTag(null)).toBeNull();
  });
});

describe('buildFocus', () => {
  const inputs = [
    pct('hit_ev_tee', 74.4, 10),   // rating 46
    pct('hit_ev_ft', 80.4, 50),    // rating 70 (rounded 69.5 -> 70)
    pct('hit_batspeed', 63, 30),   // rating 58
    pct('hit_ttc', 0.17, 85),      // rating 90
    pct('lift_vert', 24, 20),      // rating 52
    pct('lift_grip', 110, 95),     // rating 96
    abs('whoop_sleep_hrs', 6.2),   // 6 -> 40, 9 -> 99: ~44
  ];
  const model = buildPlayerRatings(inputs, []);
  const videoMap = { [videoKey('Box Jump')]: 'https://example.test/box-jump', [videoKey('Med Ball Scoop Throw')]: 'https://example.test/scoop' };

  test('a skill lists its three weakest numbers, weakest first', () => {
    const { byCategory } = buildFocus(model, [], videoMap, TODAY);
    const hit = byCategory.hitting.items;
    expect(hit).toHaveLength(FOCUS_COUNT);
    expect(hit.map(i => i.id)).toEqual(['m:hit_ev_tee', 'm:hit_batspeed', 'm:hit_ev_ft']);
    expect(hit[0].tag).toBe('priority');
    expect(hit[1].tag).toBe('develop');
    expect(hit[0].title).toBe('Drive the ball harder off the tee');
    expect(hit[0].detail).toMatch(/74\.4 mph · rated 46/);
  });

  test('every recommendation comes with drills, and library drills carry their video link', () => {
    const { byCategory } = buildFocus(model, [], videoMap, TODAY);
    for (const item of byCategory.hitting.items) {
      expect(item.drills.length).toBeGreaterThan(0);
      expect(item.drills.length).toBeLessThanOrEqual(3);
    }
    const ev = byCategory.hitting.items[0];
    expect(ev.drills.map(d => d.kind)).toEqual(['video', 'video', 'check']);
    expect(ev.drills[1]).toMatchObject({ name: 'Med Ball Scoop Throw', url: 'https://example.test/scoop' });
    // A check shows Cordell's own corrective drills for that deficiency.
    expect(ev.drills[2].forDeficiency).toBe('Arms-only swing / no hip rotation');
    expect(ev.drills[2].name).toBe('Knee-down-to-pad drill, flamingo drill');
    const vert = byCategory.lifting.items[0];
    expect(vert.drills[0]).toMatchObject({ kind: 'video', name: 'Box Jump', url: 'https://example.test/box-jump' });
    // Not in the supplied library map: still listed, just without a link.
    expect(vert.drills[1]).toMatchObject({ kind: 'video', url: null });
  });

  test('a skill with some numbers fills leftover spots with a missing core test', () => {
    const { byCategory } = buildFocus(model, [], videoMap, TODAY);
    const lift = byCategory.lifting.items;
    expect(lift.map(i => i.kind)).toEqual(['metric', 'metric', 'baseline']);
    expect(lift[2].title).toBe('Get a baseline: Approach vertical');
    expect(lift[2].drills).toEqual([]);
  });

  test('a skill with nothing measured says so and invents nothing', () => {
    const { byCategory } = buildFocus(model, [], videoMap, TODAY);
    expect(byCategory.pitching.items).toEqual([]);
    expect(byCategory.pitching.empty).toMatch(/Nothing measured yet/);
    expect(byCategory.base_running.items).toEqual([]);
  });

  test('a coach-rated skill with no numbers explains why there are no specifics', () => {
    const coached = buildPlayerRatings(inputs, [{ category: 'fielding', rating: 72, note: 'smooth hands' }]);
    const { byCategory } = buildFocus(coached, [], videoMap, TODAY);
    expect(byCategory.fielding.items).toEqual([]);
    expect(byCategory.fielding.empty).toMatch(/Coach-rated 72/);
  });

  test('WHOOP gives habits rather than drills', () => {
    const { byCategory } = buildFocus(model, [], videoMap, TODAY);
    const sleep = byCategory.whoop.items[0];
    expect(sleep.id).toBe('m:whoop_sleep_hrs');
    expect(sleep.drills.every(d => d.kind === 'habit')).toBe(true);
  });

  test('a coach-flagged deficiency becomes a focus area with its corrective drills', () => {
    const notes = [
      { area: 'hitting', deficiencies: ['Casting / bar arm'], created_at: '2026-11-03T18:00:00Z' },
      { area: 'hitting', deficiencies: ['Casting / bar arm', 'Late barrel'], created_at: '2026-10-20T18:00:00Z' },
      { area: 'pitching_throwing', deficiencies: ['Glove side flies open too early'], created_at: '2026-11-10T18:00:00Z' },
    ];
    const { byCategory } = buildFocus(model, notes, videoMap, TODAY);
    const hit = byCategory.hitting.items;
    // EV tee (rated 46 -> score 54) outranks the twice-flagged deficiency
    // (score 50), which outranks bat speed (58 -> 42).
    expect(hit.map(i => i.id)).toEqual(['m:hit_ev_tee', 'f:hitting:casting / bar arm', 'f:hitting:late barrel']);
    expect(hit[1].tag).toBe('flagged');
    expect(hit[1].detail).toBe('Flagged in 2 Mechanics notes · last 2026-11-03');
    expect(hit[1].drills[0].name).toBe('Fence drill, knob-to-ball inside tee, front-hand only');
    // A pitching/throwing flag informs both skills, even with no numbers there.
    expect(byCategory.pitching.items.map(i => i.id)).toEqual(['f:pitching_throwing:glove side flies open too early']);
    // Throwing has no numbers, so the flag leads and the two core throwing
    // tests fill the remaining spots.
    expect(byCategory.throwing.items.map(i => i.kind)).toEqual(['flag', 'baseline', 'baseline']);
    expect(byCategory.pitching.empty).toBeNull();
  });

  test('old flags and custom (unlisted) deficiencies', () => {
    const notes = [
      { area: 'hitting', deficiencies: ['Late barrel'], created_at: '2026-01-05T18:00:00Z' }, // > 180 days
      { area: 'hitting', deficiencies: ['Steps in the bucket on curveballs'], created_at: '2026-11-20T18:00:00Z' },
    ];
    const flags = flaggedDeficiencies(notes, TODAY);
    expect(flags.hitting.map(f => f.name)).toEqual(['Steps in the bucket on curveballs']);
    const { byCategory } = buildFocus(buildPlayerRatings([], []), notes, {}, TODAY);
    // A coach-typed deficiency still shows; it simply has no library drills.
    expect(byCategory.hitting.items[0]).toMatchObject({ title: 'Steps in the bucket on curveballs', drills: [] });
  });

  test('the top 3 are the weakest area from three different skills', () => {
    const { top } = buildFocus(model, [], videoMap, TODAY);
    expect(top).toHaveLength(3);
    expect(new Set(top.map(t => t.category)).size).toBe(3);
    // Hitting EV (46) and vertical (52) lead; WHOOP sleep (~44) is down-weighted
    // like it is in Overall, so it comes third rather than first.
    expect(top.map(t => t.id)).toEqual(['m:hit_ev_tee', 'm:lift_vert', 'm:whoop_sleep_hrs']);
    expect(top.every(t => t.kind !== 'baseline')).toBe(true);
  });

  test('no data at all: no top list, every skill explains itself', () => {
    const { byCategory, top } = buildFocus(buildPlayerRatings([], []), [], {}, TODAY);
    expect(top).toEqual([]);
    for (const entry of Object.values(byCategory)) {
      expect(entry.items).toEqual([]);
      expect(typeof entry.empty).toBe('string');
    }
    expect(buildFocus(null, null).top).toEqual([]);
  });
});
