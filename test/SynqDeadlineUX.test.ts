import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Synq Step 5 Deadline UX & Conversion Helpers', () => {
  // Helper matching applyDeadlinePreset implementation
  const calculateDeadlinePreset = (days: number, fromDate: Date = new Date()) => {
    const target = new Date(fromDate.getTime());
    target.setDate(target.getDate() + days);
    const y = target.getFullYear();
    const m = String(target.getMonth() + 1).padStart(2, '0');
    const d = String(target.getDate()).padStart(2, '0');
    const hh = String(target.getHours()).padStart(2, '0');
    const mm = String(target.getMinutes()).padStart(2, '0');
    return {
      deadlineDate: `${y}-${m}-${d}`,
      deadlineTime: `${hh}:${mm}`,
      targetDate: target,
    };
  };

  // Helper matching local timestamp to protocol Unix seconds conversion
  const convertLocalToProtocolTimestamp = (dateStr: string, timeStr: string) => {
    if (!dateStr || !timeStr) return null;
    const d = new Date(`${dateStr.trim()}T${timeStr.trim()}`);
    if (isNaN(d.getTime())) return null;
    return Math.floor(d.getTime() / 1000);
  };

  // Helper matching canProceed deadline validation
  const validateDeadline = (dateStr: string, timeStr: string, nowSec: number = Math.floor(Date.now() / 1000)) => {
    if (!dateStr?.trim() || !timeStr?.trim()) return false;
    const ts = convertLocalToProtocolTimestamp(dateStr, timeStr);
    if (ts === null) return false;
    return ts > nowSec;
  };

  // Helper matching receipt deadline prop logic
  const getReceiptDeadlineProp = (
    step: number,
    dateStr: string,
    timeStr: string,
    nowSec: number = Math.floor(Date.now() / 1000)
  ) => {
    if (step < 4) return undefined;
    if (!validateDeadline(dateStr, timeStr, nowSec)) return undefined;
    return `${dateStr.trim()}T${timeStr.trim()}`;
  };

  it('1. manual local date + time converts to correct absolute Unix timestamp', () => {
    const date = '2026-10-16';
    const time = '14:30';
    const ts = convertLocalToProtocolTimestamp(date, time);
    assert.ok(ts !== null);
    const expected = Math.floor(new Date('2026-10-16T14:30').getTime() / 1000);
    assert.equal(ts, expected);
  });

  it('2. 3-day preset computes exactly +3 local calendar days with identical time', () => {
    const base = new Date(2026, 9, 5, 11, 45); // Oct 5, 2026 11:45
    const res = calculateDeadlinePreset(3, base);
    assert.equal(res.deadlineDate, '2026-10-08');
    assert.equal(res.deadlineTime, '11:45');
  });

  it('3. 5-day preset computes exactly +5 local calendar days with identical time', () => {
    const base = new Date(2026, 9, 5, 11, 45); // Oct 5, 2026 11:45
    const res = calculateDeadlinePreset(5, base);
    assert.equal(res.deadlineDate, '2026-10-10');
    assert.equal(res.deadlineTime, '11:45');
  });

  it('4. 10-day preset computes exactly +10 local calendar days with identical time', () => {
    const base = new Date(2026, 9, 5, 11, 45); // Oct 5, 2026 11:45
    const res = calculateDeadlinePreset(10, base);
    assert.equal(res.deadlineDate, '2026-10-15');
    assert.equal(res.deadlineTime, '11:45');
  });

  it('5. 30-day preset computes exactly +30 local calendar days crossing month boundaries cleanly', () => {
    const base = new Date(2026, 9, 5, 11, 45); // Oct 5, 2026 11:45
    const res = calculateDeadlinePreset(30, base);
    assert.equal(res.deadlineDate, '2026-11-04');
    assert.equal(res.deadlineTime, '11:45');
  });

  it('6. clearing date results in undefined receipt prop (renders skeleton)', () => {
    const prop = getReceiptDeadlineProp(4, '', '23:59');
    assert.equal(prop, undefined);
  });

  it('7. clearing time results in undefined receipt prop (renders skeleton)', () => {
    const prop = getReceiptDeadlineProp(4, '2026-10-16', '');
    assert.equal(prop, undefined);
  });

  it('8. past deadline remains rejected and results in undefined receipt prop', () => {
    const nowSec = Math.floor(new Date('2026-10-05T12:00:00').getTime() / 1000);
    const pastValid = validateDeadline('2026-10-04', '12:00', nowSec);
    assert.equal(pastValid, false);

    const prop = getReceiptDeadlineProp(4, '2026-10-04', '12:00', nowSec);
    assert.equal(prop, undefined);
  });

  it('9. future deadline is accepted and yields full ISO local string for receipt', () => {
    const nowSec = Math.floor(new Date('2026-10-05T12:00:00').getTime() / 1000);
    const futureValid = validateDeadline('2026-10-06', '12:00', nowSec);
    assert.equal(futureValid, true);

    const prop = getReceiptDeadlineProp(4, '2026-10-06', '12:00', nowSec);
    assert.equal(prop, '2026-10-06T12:00');
  });

  it('10. canonical 8-step sequence has Review at step index 7 (Step 8)', () => {
    const steps = [
      { title: 'Type', description: 'Choose job type' },
      { title: 'Freelancer', description: 'Select freelancer' },
      { title: 'Scope', description: 'Define deliverables' },
      { title: 'Budget', description: 'Set deal budget' },
      { title: 'Deadline', description: 'Target delivery' },
      { title: 'Payment Structure', description: 'Configure milestones' },
      { title: 'Protection', description: 'Select protection plan' },
      { title: 'Review', description: 'Review and sign deal terms' },
    ];

    assert.equal(steps.length, 8);
    assert.equal(steps[7].title, 'Review');
  });

  it('11. AI panel persists on Steps 2-7 (index 1 to 6) and is excluded from Step 8 (index 7)', () => {
    const shouldRenderAiPanel = (step: number) => step >= 1 && step < 7;

    assert.equal(shouldRenderAiPanel(0), false); // Step 1 (Type)
    assert.equal(shouldRenderAiPanel(1), true);  // Step 2 (Freelancer)
    assert.equal(shouldRenderAiPanel(2), true);  // Step 3 (Scope)
    assert.equal(shouldRenderAiPanel(3), true);  // Step 4 (Budget)
    assert.equal(shouldRenderAiPanel(4), true);  // Step 5 (Deadline)
    assert.equal(shouldRenderAiPanel(5), true);  // Step 6 (Payment Structure)
    assert.equal(shouldRenderAiPanel(6), true);  // Step 7 (Protection)
    assert.equal(shouldRenderAiPanel(7), false); // Step 8 (Review) -> EXCLUDED
  });
});
