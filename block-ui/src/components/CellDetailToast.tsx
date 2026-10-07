import React, { useEffect } from 'react';
import type { CellDetail } from '../types';
import { amazonDpUrl } from '../utils/amazon';
import { formatPagePos } from '../utils/pagePos';

interface Props {
  detail: CellDetail | null;
  onClose: () => void;
}

export function CellDetailToast({
  detail,
  onClose,
}: Props): React.ReactElement | null {
  useEffect(() => {
    if (!detail) return;
    const t = window.setTimeout(onClose, 6000);
    return () => window.clearTimeout(t);
  }, [detail, onClose]);

  if (!detail) return null;

  return (
    <div className="local-toast" role="status">
      <button type="button" className="toast-close" onClick={onClose}>
        ×
      </button>
      <div className="toast-title">Cell detail</div>
      {detail.image_url ? (
        <img className="toast-img" src={detail.image_url} alt="" />
      ) : (
        <div className="toast-img placeholder" aria-label="No product image" />
      )}
      <dl className="toast-dl">
        <dt>keyword</dt>
        <dd>{detail.keyword}</dd>
        <dt>snapshot_day</dt>
        <dd>{detail.snapshot_day}</dd>
        <dt>asin</dt>
        <dd>
          {detail.asin ? (
            <a
              href={amazonDpUrl(detail.asin)}
              target="_blank"
              rel="noreferrer"
            >
              {detail.asin}
            </a>
          ) : (
            '—'
          )}
        </dd>
        <dt>organic_rank</dt>
        <dd>{detail.organic_rank == null ? '—' : detail.organic_rank}</dd>
        <dt>position_on_page</dt>
        <dd>{formatPagePos(detail.page_number, detail.position_on_page) ?? '—'}</dd>
        <dt>price_cents</dt>
        <dd>{detail.price_cents == null ? '—' : detail.price_cents}</dd>
        <dt>status</dt>
        <dd>{detail.status}</dd>
        <dt>run_id</dt>
        <dd>{detail.run_id || '—'}</dd>
      </dl>
    </div>
  );
}
