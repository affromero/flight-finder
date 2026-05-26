'use client';

import { useState } from 'react';
import styles from './ChartActions.module.css';

interface Snapshot {
  travelDate: string;
  price: number;
  currency: string;
  airline: string;
  stops: number;
  departureTime: string | null;
  arrivalTime: string | null;
  duration: string | null;
  scrapedAt: string;
}

interface Props {
  queryId: string;
  origin: string;
  destination: string;
  snapshots: Snapshot[];
}

export function ChartActions({ queryId, origin, destination, snapshots }: Props) {
  const [copied, setCopied] = useState(false);

  const handleShare = () => {
    const url = `${window.location.origin}/q/${queryId}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleExport = () => {
    const header = 'Date Scraped,Travel Date,Price,Currency,Airline,Stops,Duration,Departure,Arrival\n';
    const rows = snapshots.map((s) =>
      [
        new Date(s.scrapedAt).toISOString(),
        s.travelDate.split('T')[0],
        s.price,
        s.currency,
        `"${s.airline}"`,
        s.stops,
        s.duration ?? '',
        s.departureTime ?? '',
        s.arrivalTime ?? '',
      ].join(',')
    );
    const csv = header + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `flight-finder-${origin}-${destination}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={styles.root}>
      <button className={styles.btn} onClick={handleShare} title="Copy shareable link">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M6 10l4-4M7.5 3.5L9.9 1.1a1.5 1.5 0 0 1 2.1 0l2.9 2.9a1.5 1.5 0 0 1 0 2.1L12.5 8.5M8.5 12.5L6.1 14.9a1.5 1.5 0 0 1-2.1 0L1.1 12a1.5 1.5 0 0 1 0-2.1L3.5 7.5" />
        </svg>
        {copied ? 'Copied!' : 'Share'}
      </button>
      <button className={styles.btn} onClick={handleExport} title="Download CSV">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2 11v2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2M8 2v9M5 8l3 3 3-3" />
        </svg>
        CSV
      </button>
    </div>
  );
}
