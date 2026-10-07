import React, { useEffect, useMemo, useRef, useState } from 'react';
import { filterOwners, initials, type OwnerOption } from '../data/members';

interface Props {
  value: string; // owner id ('' = none)
  options: OwnerOption[];
  onChange: (id: string) => void;
  disabled?: boolean;
  /** shown under the list (member table status) */
  footnote?: string;
}

export function Avatar({ option, size = 22 }: { option: Pick<OwnerOption, 'name' | 'avatar'>; size?: number }): React.ReactElement {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (option.avatar && !broken) {
    return <img className="op-avatar" src={option.avatar} alt="" style={style} onError={() => setBroken(true)} referrerPolicy="no-referrer" />;
  }
  return (
    <span className="op-avatar op-initials" style={style} aria-hidden>
      {initials(option.name)}
    </span>
  );
}

const MAX_SHOWN = 200;

/** Searchable owner select (whole org from Base table `member`), with "no owner" to clear. */
export function OwnerPicker({ value, options, onChange, disabled = false, footnote }: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const selected = useMemo(() => options.find((o) => o.id === value) ?? (value ? { id: value, name: value, source: 'owner' as const } : null), [options, value]);
  const matches = useMemo(() => filterOwners(options, query), [options, query]);
  // index 0 = "no owner"; members start at 1
  const rows = matches.slice(0, MAX_SHOWN);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    setTimeout(() => input.current?.focus(), 0);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  useEffect(() => setActive(query ? 1 : 0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery('');
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(rows.length, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active === 0) choose('');
      else if (rows[active - 1]) choose(rows[active - 1].id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className={`op-root${open ? ' open' : ''}`} ref={root}>
      <div className="op-control">
        <button
          type="button"
          className={`op-button${selected ? '' : ' empty'}`}
          onClick={() => setOpen((v) => !v)}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={selected ? `${selected.name}${selected.enName && selected.enName !== selected.name ? ` · ${selected.enName}` : ''}` : 'Chọn owner'}
        >
          {selected ? (
            <>
              <Avatar option={selected} />
              <span className="op-name">{selected.name}</span>
            </>
          ) : (
            <span className="op-placeholder">Chọn owner…</span>
          )}
          <span className="op-caret" aria-hidden>
            ▾
          </span>
        </button>
        {selected && !disabled && (
          <button type="button" className="op-clear" title="Bỏ owner" aria-label="Bỏ owner" onClick={() => choose('')}>
            ×
          </button>
        )}
      </div>
      {open && (
        <div className="op-panel" role="dialog">
          <input
            ref={input}
            className="filter-input op-search"
            value={query}
            placeholder={`Tìm trong ${options.length} người (tên, phòng ban)…`}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            aria-label="Tìm owner"
          />
          <ul className="op-list" role="listbox" ref={list}>
            <li
              data-idx={0}
              role="option"
              aria-selected={!value}
              className={`op-item op-none${active === 0 ? ' active' : ''}${!value ? ' selected' : ''}`}
              onMouseEnter={() => setActive(0)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose('');
              }}
            >
              — Không owner —
            </li>
            {rows.map((o, i) => (
              <li
                key={o.id}
                data-idx={i + 1}
                role="option"
                aria-selected={o.id === value}
                className={`op-item${active === i + 1 ? ' active' : ''}${o.id === value ? ' selected' : ''}`}
                onMouseEnter={() => setActive(i + 1)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(o.id);
                }}
              >
                <Avatar option={o} size={26} />
                <span className="op-item-text">
                  <span className="op-item-name">
                    {o.name}
                    {o.enName && o.enName !== o.name ? <span className="muted"> · {o.enName}</span> : null}
                  </span>
                  <span className="op-item-sub">{o.departments || (o.source === 'owner' ? 'owner hiện có' : '')}</span>
                </span>
                {o.id === value && <span className="op-check">✓</span>}
              </li>
            ))}
            {!matches.length && <li className="op-empty">Không tìm thấy “{query}”</li>}
            {matches.length > MAX_SHOWN && <li className="op-empty">… còn {matches.length - MAX_SHOWN} người — gõ thêm để lọc</li>}
          </ul>
          {footnote && <div className="op-foot">{footnote}</div>}
        </div>
      )}
    </div>
  );
}
