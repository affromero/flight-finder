'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/currency';
import styles from './PriceAlerts.module.css';

interface Alert {
  queryId: string;
  origin: string;
  destination: string;
  currency: string | null;
  previousMin: number;
  currentMin: number;
  drop: number;
  airline: string;
}

export function PriceAlerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(() => {
    fetch('/api/alerts')
      .then((res) => res.json())
      .then((data) => {
        if (data.ok && data.data.alerts.length > 0) {
          setAlerts(data.data.alerts);
        }
      })
      .catch(() => {});
  }, []);

  if (alerts.length === 0) return null;

  return (
    <div className={styles.root}>
      {alerts.map((a) => (
        <Link key={a.queryId} href={`/q/${a.queryId}`} className={styles.alert}>
          <span className={styles.dropBadge}>
            -{formatCurrency(a.drop, a.currency)}
          </span>
          <div className={styles.alertBody}>
            <span className={styles.alertRoute}>
              {a.origin} &rarr; {a.destination}
            </span>
            <span className={styles.alertDetail}>
              {a.airline} &middot; now {formatCurrency(a.currentMin, a.currency)} (was {formatCurrency(a.previousMin, a.currency)})
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}
