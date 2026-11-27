import {
  metricDirection, changeStatus, buildAssessmentTrend, pointSeries,
  splitLabelUnit, shortDate, chartPositions, pctText, PLATEAU_PCT,
} from './AssessmentTrends';

describe('metricDirection (#497) — real labels from the live templates', () => {
  test.each([
    ['Bat Speed (MPH):', 'higher'],
    ['Exit Velo Tee Middle (MPH):', 'higher'],
    ['Front Toss EV (MPH):', 'higher'],
    ['Vertical Jump (in):', 'higher'],
    ['Grip Strength (R/L):', 'higher'],
    ['Pushups to Failure:', 'higher'],
    ['Pulldown Velo 5 Ounce (MPH):', 'higher'],
    ['Trap Bar Deadlift (X BW)', 'higher'],
    ['T-Spine Rotation', 'higher'],
    ['Rotational Acceleration ', 'higher'],
    ['Time to Contact (Seconds)', 'lower'],
    ['10 Yard Sprint (Sec):', 'lower'],
    ['60 Time (Seconds):', 'lower'],
    ['Home to 1st Base Time', 'lower'],
    ['Home to Home ', 'lower'],
    ['Straight Steal Time ', 'lower'],
    ['Throw Down 2nd Base (Seconds/MPH):', 'lower'],
    ['Height (in):', 'neutral'],
    ['Weight (lbs):', 'neutral'],
    ['Bat Length (in)/ Weight (oz):', 'neutral'],
    ['Training age', 'neutral'],
    ['Attack Angle', 'neutral'],
    ['How many warmup pitches off mound? Wind / Stretch total each? ', 'neutral'],
  ])('%s -> %s', (label, expected) => {
    expect(metricDirection(label)).toBe(expected);
  });

  test('a template element can override the guess', () => {
    expect(metricDirection('Bat Speed (MPH):', 'lower')).toBe('lower');
    expect(metricDirection('Time to Contact (Seconds)', 'higher')).toBe('higher');
    expect(metricDirection('Bat Speed (MPH):', 'none')).toBe('neutral');
  });
});

describe('changeStatus (#497)', () => {
  test('higher-is-better: the Hitting Assessment in the issue screenshot', () => {
    expect(changeStatus(60.6, 63, 'higher')).toBe('progress'); // bat speed +4%
    expect(changeStatus(74.4, 81.4, 'higher')).toBe('progress');
    expect(changeStatus(78.1, 79.1, 'higher')).toBe('plateau'); // +1.3%
    expect(changeStatus(81.4, 74.4, 'higher')).toBe('regression');
    expect(changeStatus(33, 33, 'higher')).toBe('plateau');
  });

  test('lower-is-better flips progress and regression', () => {
    expect(changeStatus(4.6, 4.3, 'lower')).toBe('progress');
    expect(changeStatus(4.3, 4.6, 'lower')).toBe('regression');
    expect(changeStatus(0.19, 18, 'lower')).toBe('regression'); // the typo'd row still reads the right way
    expect(changeStatus(4.3, 4.31, 'lower')).toBe('plateau');
  });

  test('the plateau band is under PLATEAU_PCT of the previous value', () => {
    expect(PLATEAU_PCT).toBe(2);
    expect(changeStatus(100, 101.9, 'higher')).toBe('plateau');
    expect(changeStatus(100, 102, 'higher')).toBe('progress');
    expect(changeStatus(100, 98.1, 'higher')).toBe('plateau');
    expect(changeStatus(100, 98, 'higher')).toBe('regression');
  });

  test('neutral measures are never judged; a missing side gives nothing', () => {
    expect(changeStatus(180, 190, 'neutral')).toBe('neutral');
    expect(changeStatus(null, 5, 'higher')).toBeNull();
    expect(changeStatus(5, null, 'higher')).toBeNull();
  });

  test('a previous value of zero does not divide by zero', () => {
    expect(changeStatus(0, 5, 'higher')).toBe('progress');
    expect(changeStatus(0, 0, 'higher')).toBe('plateau');
    expect(changeStatus(0, -2, 'higher')).toBe('regression');
  });
});

describe('series building', () => {
  const schema = [
    { id: 'a', type: 'text_field', label: 'Bat Speed (MPH):', sort_order: 1 },
    { id: 'b', type: 'text_field', label: 'Time to Contact (Seconds)', sort_order: 2 },
    { id: 'c', type: 'text_field', label: 'Bat Brand / Model:', sort_order: 3 },
    { id: 't', type: 'table', label: 'Jumps', rows: ['Vertical'], columns: ['in'], sort_order: 4 },
  ];
  // Deliberately out of order: the trend must sort oldest first.
  const subs = [
    { id: 's3', assessment_date: '2026-11-16', created_at: '2026-11-16T10:00:00Z', responses: { a: '63', b: '0.17', t: { Vertical: { in: '27.5' } } } },
    { id: 's1', assessment_date: '2026-08-18', created_at: '2026-08-18T10:00:00Z', responses: { a: '60.6 mph', b: '0.19', c: 'Marucci CatX', t: { Vertical: { in: '24' } } } },
    { id: 's2', assessment_date: '2026-10-05', created_at: '2026-10-05T10:00:00Z', responses: { a: '', b: '0.18' } },
  ];

  test('points carry a direction and values in date order', () => {
    const { submissions, points } = buildAssessmentTrend(schema, subs);
    expect(submissions.map(s => s.id)).toEqual(['s1', 's2', 's3']);
    const bat = points.find(p => p.key === 'a');
    expect(bat.values).toEqual([60.6, null, 63]);
    expect(bat.direction).toBe('higher');
    expect(points.find(p => p.key === 'b').direction).toBe('lower');
    expect(points.find(p => p.key === 't|Vertical|in').values).toEqual([24, null, 27.5]);
    // Free text with no number never becomes a data point.
    expect(points.find(p => p.key === 'c')).toBeUndefined();
  });

  test('pointSeries drops the assessments that skipped the field', () => {
    const { submissions, points } = buildAssessmentTrend(schema, subs);
    const series = pointSeries(points.find(p => p.key === 'a'), submissions);
    expect(series).toEqual([
      { value: 60.6, date: '2026-08-18', id: 's1' },
      { value: 63, date: '2026-11-16', id: 's3' },
    ]);
  });
});

describe('chart helpers', () => {
  test('splitLabelUnit pulls the unit out of the label', () => {
    expect(splitLabelUnit('Exit Velo Tee Middle (MPH):')).toEqual({ title: 'Exit Velo Tee Middle', unit: 'MPH' });
    expect(splitLabelUnit('Time to Contact (Seconds)')).toEqual({ title: 'Time to Contact', unit: 'Seconds' });
    expect(splitLabelUnit('Rotational Acceleration ')).toEqual({ title: 'Rotational Acceleration', unit: '' });
    expect(splitLabelUnit('Jumps · Vertical')).toEqual({ title: 'Jumps · Vertical', unit: '' });
    // Two measures in one field: no single unit to pull out.
    expect(splitLabelUnit('Bat Length (in)/ Weight (oz):')).toEqual({ title: 'Bat Length (in)/ Weight (oz)', unit: '' });
  });

  test('pctText keeps a decimal for small changes', () => {
    expect(pctText(1.66)).toBe('1.7');
    expect(pctText(-0.99)).toBe('-1');
    expect(pctText(9374.2)).toBe('9374');
    expect(pctText(12.4)).toBe('12');
  });

  test('shortDate', () => {
    expect(shortDate('2026-08-18')).toBe('8/18');
    expect(shortDate('2026-11-16', true)).toBe('11/16/26');
    expect(shortDate('')).toBe('');
  });

  test('chartPositions run 0 to 1 in order and follow the real gaps', () => {
    const even = chartPositions([{ date: '2026-01-01' }, { date: '2026-02-01' }, { date: '2026-03-01' }]);
    expect(even[0]).toBe(0);
    expect(even[2]).toBe(1);
    // A reassessment 3 days after the first sits left of centre, but not on top of it.
    const lopsided = chartPositions([{ date: '2026-01-01' }, { date: '2026-01-04' }, { date: '2026-07-01' }]);
    expect(lopsided[1]).toBeGreaterThan(0.15);
    expect(lopsided[1]).toBeLessThan(0.5);
    expect(lopsided[0]).toBeLessThan(lopsided[1]);
    expect(lopsided[1]).toBeLessThan(lopsided[2]);
    // Same-day reassessments and single points still get sane positions.
    expect(chartPositions([{ date: '2026-01-01' }, { date: '2026-01-01' }])).toEqual([0, 1]);
    expect(chartPositions([{ date: '2026-01-01' }])).toEqual([0.5]);
    expect(chartPositions([])).toEqual([]);
  });
});
