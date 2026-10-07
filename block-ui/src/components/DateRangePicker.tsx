import React, { useEffect, useRef, useState } from 'react';

type Range = { from: string; to: string };
type Preset = 'all' | '7' | '14' | '30' | 'custom';

interface Props {
  from: string;
  to: string;
  minDay: string;
  maxDay: string;
  onApply: (range: Range) => void;
}

const weekdays = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthOf = (day: string) => day ? day.slice(0, 7) : iso(new Date()).slice(0, 7);
const shiftMonth = (month: string, delta: number) => {
  const [year, index] = month.split('-').map(Number);
  return iso(new Date(Date.UTC(year, index - 1 + delta, 1))).slice(0, 7);
};
const shiftDays = (day: string, delta: number) => {
  const [year, month, date] = day.split('-').map(Number);
  return iso(new Date(Date.UTC(year, month - 1, date + delta)));
};
const monthLabel = (month: string) => {
  const [year, index] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, index - 1, 1))).toUpperCase();
};
const formatDay = (day: string) => day ? `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}` : 'Chọn ngày';

function Calendar({ month, range, minDay, maxDay, onSelect, onMonthChange, title }: {
  month: string;
  range: Range;
  minDay: string;
  maxDay: string;
  onSelect: (day: string) => void;
  onMonthChange: (month: string) => void;
  title: string;
}): React.ReactElement {
  const [year, index] = month.split('-').map(Number);
  const firstWeekday = new Date(Date.UTC(year, index - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(year, index, 0)).getUTCDate();
  const cells = Array.from({ length: firstWeekday + days }, (_, i) => i < firstWeekday ? '' : `${month}-${String(i - firstWeekday + 1).padStart(2, '0')}`);
  return <div className="range-calendar">
    <div className="range-calendar-title">{title}</div>
    <div className="range-calendar-head">
      <button type="button" onClick={() => onMonthChange(shiftMonth(month, -1))} aria-label={`Previous month, ${title}`}>‹</button>
      <strong>{monthLabel(month)}</strong>
      <button type="button" onClick={() => onMonthChange(shiftMonth(month, 1))} aria-label={`Next month, ${title}`}>›</button>
    </div>
    <div className="range-calendar-grid range-weekdays">{weekdays.map((d, i) => <span key={i}>{d}</span>)}</div>
    <div className="range-calendar-grid">
      {cells.map((day, i) => day ? <button
        key={day} type="button" aria-label={day} aria-pressed={day === range.from || day === range.to}
        className={`${day === range.from || day === range.to ? 'selected' : ''} ${range.from && range.to && day > range.from && day < range.to ? 'within' : ''}`}
        disabled={Boolean((minDay && day < minDay) || (maxDay && day > maxDay))}
        onClick={() => onSelect(day)}
      >{i - firstWeekday + 1}</button> : <span key={`blank-${i}`} />)}
    </div>
  </div>;
}

export function DateRangePicker({ from, to, minDay, maxDay, onApply }: Props): React.ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Range>({ from, to });
  const [choosingEnd, setChoosingEnd] = useState(false);
  const [startMonth, setStartMonth] = useState(monthOf(from || maxDay));
  const [endMonth, setEndMonth] = useState(monthOf(to || maxDay));

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
  }, [open]);

  const openPicker = () => {
    setDraft({ from, to });
    setStartMonth(monthOf(from || maxDay));
    setEndMonth(monthOf(to || maxDay));
    setChoosingEnd(false);
    setOpen(true);
  };
  const selectDay = (day: string) => {
    if (!choosingEnd || !draft.from) {
      setDraft({ from: day, to: '' });
      setChoosingEnd(true);
    } else {
      setDraft(day < draft.from ? { from: day, to: draft.from } : { from: draft.from, to: day });
      setChoosingEnd(false);
    }
  };
  const preset: Preset = !from && !to ? 'all' : ([7, 14, 30] as const).find(n => maxDay && to === maxDay && from === shiftDays(maxDay, 1 - n))?.toString() as Preset || 'custom';
  const applyPreset = (selected: Preset) => {
    if (selected === 'custom') { openPicker(); return; }
    onApply(selected === 'all' || !maxDay ? { from: '', to: '' } : { from: shiftDays(maxDay, 1 - Number(selected)), to: maxDay });
  };

  return <div className="date-range-control" ref={root}>
    <select className="date-range-auto" aria-label="Auto date range" value={preset} onChange={e => applyPreset(e.target.value as Preset)}>
      <option value="all">All dates</option><option value="7">Last 7 days</option><option value="14">Last 14 days</option><option value="30">Last 30 days</option><option value="custom">Custom range…</option>
    </select>
    <button type="button" className="date-range-trigger" aria-expanded={open} onClick={() => open ? setOpen(false) : openPicker()}>
      {from || to ? `${formatDay(from)} → ${formatDay(to)}` : 'Chọn khoảng ngày'} <span>▾</span>
    </button>
    {open && <div className="date-range-popover" role="dialog" aria-label="Select date range">
      <div className="date-range-months">
        <Calendar title="Start Date" month={startMonth} range={draft} minDay={minDay} maxDay={maxDay} onSelect={selectDay} onMonthChange={setStartMonth} />
        <Calendar title="End Date" month={endMonth} range={draft} minDay={minDay} maxDay={maxDay} onSelect={selectDay} onMonthChange={setEndMonth} />
      </div>
      <div className="date-range-actions">
        <span>{draft.from ? `${formatDay(draft.from)} → ${formatDay(draft.to)}` : 'Tất cả ngày'}</span>
        <button type="button" onClick={() => setOpen(false)}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!draft.from || !draft.to} onClick={() => { onApply(draft); setOpen(false); }}>Apply</button>
      </div>
    </div>}
  </div>;
}
