/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dateIn,
  daysInMonth,
  isDate,
  isMonth,
  maxMonth,
  monthIn,
  nextMonth,
  registerableRange,
  scheduledDate,
} from '../src/months.ts';

describe('isMonth', () => {
  it('YYYY-MM だけを通す', () => {
    assert.equal(isMonth('2026-11'), true);
    assert.equal(isMonth('2026-01'), true);
    assert.equal(isMonth('2026-12'), true);
    for (const value of ['2026-00', '2026-13', '2026-1', '26-11', '2026-11-01', '2026/11', '', null, 202611, undefined]) {
      assert.equal(isMonth(value), false, String(value));
    }
  });
});

describe('isDate', () => {
  it('実在する日付だけを通す', () => {
    assert.equal(isDate('2026-11-19'), true);
    assert.equal(isDate('2028-02-29'), true);
    assert.equal(isDate('2026-12-31'), true);
    for (const value of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2026-11-00', '2026-11-1', '2026-11', null, 20261119]) {
      assert.equal(isDate(value), false, String(value));
    }
  });
});

describe('nextMonth・maxMonth', () => {
  it('年をまたぐ', () => {
    assert.equal(nextMonth('2026-11'), '2026-12');
    assert.equal(nextMonth('2026-12'), '2027-01');
    assert.equal(nextMonth('2026-01'), '2026-02');
  });

  it('月は文字列のまま大きいほうを選べる', () => {
    assert.equal(maxMonth('2026-09', '2026-11'), '2026-11');
    assert.equal(maxMonth('2027-01', '2026-12'), '2027-01');
    assert.equal(maxMonth('2026-11', '2026-11'), '2026-11');
  });
});

describe('monthIn（グループのタイムゾーンで月を決める）', () => {
  it('UTCでは11月でも、東京ではもう12月', () => {
    const utcNovemberEnd = Date.UTC(2026, 10, 30, 16, 0, 0); // 東京は12/1 01:00
    assert.equal(monthIn('Asia/Tokyo', utcNovemberEnd), '2026-12');
    assert.equal(monthIn('UTC', utcNovemberEnd), '2026-11');
    assert.equal(monthIn('America/Los_Angeles', utcNovemberEnd), '2026-11');
  });

  it('月初と月末の境目', () => {
    assert.equal(monthIn('Asia/Tokyo', Date.UTC(2026, 10, 30, 14, 59, 59)), '2026-11'); // 11/30 23:59:59
    assert.equal(monthIn('Asia/Tokyo', Date.UTC(2026, 10, 30, 15, 0, 0)), '2026-12'); // 12/1 00:00:00
  });
});

describe('registerableRange（8章「支出の対象月」）', () => {
  it('まだ締めていなければ、作成月から今月まで', () => {
    assert.deepEqual(
      registerableRange({ createdMonth: '2026-10', currentMonth: '2026-11', latestClosedMonth: null }),
      { from: '2026-10', to: '2026-11' },
    );
  });

  it('作った月と今月が同じなら、その1か月だけ', () => {
    assert.deepEqual(
      registerableRange({ createdMonth: '2026-11', currentMonth: '2026-11', latestClosedMonth: null }),
      { from: '2026-11', to: '2026-11' },
    );
  });

  it('締めた月の翌月から今月まで', () => {
    assert.deepEqual(
      registerableRange({ createdMonth: '2026-08', currentMonth: '2026-11', latestClosedMonth: '2026-09' }),
      { from: '2026-10', to: '2026-11' },
    );
  });

  it('前の月までを締めていれば、今月だけ', () => {
    assert.deepEqual(
      registerableRange({ createdMonth: '2026-08', currentMonth: '2026-11', latestClosedMonth: '2026-10' }),
      { from: '2026-11', to: '2026-11' },
    );
  });

  it('今月を早めに締めた後は、翌月だけ', () => {
    assert.deepEqual(
      registerableRange({ createdMonth: '2026-08', currentMonth: '2026-11', latestClosedMonth: '2026-11' }),
      { from: '2026-12', to: '2026-12' },
    );
  });

  it('年をまたぐ', () => {
    assert.deepEqual(
      registerableRange({ createdMonth: '2026-08', currentMonth: '2026-12', latestClosedMonth: '2026-12' }),
      { from: '2027-01', to: '2027-01' },
    );
  });
});

describe('dateIn', () => {
  it('タイムゾーンの日付を返す。UTCと日付がずれる時刻でも、タイムゾーンの日付', () => {
    // 2026-11-30 15:30 UTC は、東京では 12-01 00:30、ロサンゼルスでは 11-30 07:30。
    const now = Date.UTC(2026, 10, 30, 15, 30, 0);
    assert.equal(dateIn('Asia/Tokyo', now), '2026-12-01');
    assert.equal(dateIn('America/Los_Angeles', now), '2026-11-30');
    assert.equal(dateIn('UTC', now), '2026-11-30');
    assert.equal(monthIn('Asia/Tokyo', now), '2026-12');
  });
});

describe('daysInMonth・scheduledDate（固定費の予定日。7章）', () => {
  it('月の日数（うるう年を含む）', () => {
    assert.equal(daysInMonth('2026-01'), 31);
    assert.equal(daysInMonth('2026-04'), 30);
    assert.equal(daysInMonth('2026-02'), 28);
    assert.equal(daysInMonth('2028-02'), 29);
    assert.equal(daysInMonth('2100-02'), 28);
    assert.equal(daysInMonth('2000-02'), 29);
    assert.equal(daysInMonth('2026-12'), 31);
  });

  it('その月に無い日は、月末日にする', () => {
    assert.equal(scheduledDate('2026-11', 25), '2026-11-25');
    assert.equal(scheduledDate('2026-11', 30), '2026-11-30');
    assert.equal(scheduledDate('2026-11', 31), '2026-11-30');
    assert.equal(scheduledDate('2026-04', 31), '2026-04-30');
    assert.equal(scheduledDate('2026-02', 29), '2026-02-28');
    assert.equal(scheduledDate('2028-02', 29), '2028-02-29');
    assert.equal(scheduledDate('2028-02', 31), '2028-02-29');
    assert.equal(scheduledDate('2026-12', 1), '2026-12-01');
    assert.equal(scheduledDate('2026-10', 5), '2026-10-05');
  });
});
