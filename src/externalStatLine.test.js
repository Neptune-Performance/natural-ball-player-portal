import { parseCsv } from './statFileReader';
import { extractStatCandidates, pickCandidate, normalizeStatLine } from './externalStatLine';

// Shape of a GameChanger team export: section row, wide header, one row per player.
const GC = [
  ',,,Batting,,,,,,,,,Pitching,,,,,,,',
  'Number,Last,First,GP,PA,AB,AVG,OBP,OPS,SLG,H,BB,IP,BF,H,BB,SO,ERA,WHIP',
  '55,K,Moses,3,7,4,.750,.857,2.357,1.500,3,3,4.0,19,7,2,4,4.500,2.250',
  '44,Liperi,Ben,10,34,28,.286,.412,.769,.357,8,4,11.1,76,22,17,17,13.24,3.441',
  'Totals,,,,,,,,,,,,,,,,,,',
].join('\n');

test('GameChanger export: picks the athlete row and splits sections', () => {
  const c = extractStatCandidates(parseCsv(GC));
  expect(c.map((x) => x.name)).toEqual(['Moses K', 'Ben Liperi']);
  const ben = normalizeStatLine(pickCandidate(c, 'Ben Liperi'));
  expect(ben.batting).toMatchObject({ pa: 34, obp: 0.412, h: 8, bb: 4 });
  // H / BB repeat under Pitching; they must not overwrite the batting values.
  expect(ben.pitching).toMatchObject({ ip: 11.1, bf: 76, h: 22, bb: 17, so: 17, whip: 3.441 });
  expect(pickCandidate(c, 'Somebody Else')).toBeNull();
});

test('hand-built blocks with blank lines under the headers', () => {
  const grid = [
    ['Lucas Stats', '', 'Fall Ball 2026'],
    [],
    ['Batting', 'GP', 'PA', 'AB', 'Avg', 'OBP', 'OPS', 'H', 'BB'],
    [],
    ['', '6', '19', '17', '0.824', '0.842', '2.077', '14', '1'],
    ['Pitching', 'IP', 'BF', 'H', 'BB', 'SO', 'WHIP'],
    ['', '9', '46', '3', '14', '28', '1.889'],
  ];
  const line = normalizeStatLine(pickCandidate(extractStatCandidates(grid), 'Lucas Cordova'));
  expect(line.batting).toMatchObject({ pa: 19, obp: 0.842, ops: 2.077 });
  expect(line.pitching).toMatchObject({ ip: 9, bf: 46, so: 28, whip: 1.889 });
});

test('derives OBP / WHIP from counting stats', () => {
  const line = normalizeStatLine({ batting: { ab: 10, h: 3, bb: 2 }, pitching: { ip: 4.2, h: 5, bb: 2 } });
  expect(line.batting).toMatchObject({ pa: 12, obp: 0.417, avg: 0.3 });
  expect(line.pitching.whip).toBe(1.5);
  expect(normalizeStatLine({ batting: {}, pitching: {} })).toBeNull();
});
