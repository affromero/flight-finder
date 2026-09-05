'use client';
import Image from 'next/image';
import { useLocale, useTranslations } from 'next-intl';
import type { HotelOffer } from '@/lib/hotels/types';
import { hotelMoney, safeHotelUrl } from './client';
import styles from './Hotels.module.css';
export function HotelOfferCard({ offer, busy, onTrack }: { offer: HotelOffer; busy: boolean; onTrack: () => void }) {
  const t = useTranslations('Hotels'); const locale = useLocale();
  const image = offer.imageUrl && safeHotelUrl(offer.imageUrl);
  const booking = safeHotelUrl(offer.bookingUrl);
  return <article className={styles.offer}>
    {image ? <Image unoptimized src={image} width={400} height={300} alt={offer.hotelName} className={styles.photo} /> : <div className={styles.noPhoto} aria-hidden="true">⌂</div>}
    <div className={styles.offerBody}><span className={styles.eyebrow}>{offer.seller}</span><h3>{offer.hotelName}</h3><p className={styles.muted}>{offer.address}</p><p className={styles.muted}>{offer.checkIn} → {offer.checkOut} · {t('roomCount', { count: offer.rooms.length })}</p>
      <div className={styles.price}>{hotelMoney(offer.totalPrice, offer.currency, locale)}</div><span className={styles.muted}>{t(offer.taxesIncluded ? 'totalIncluded' : 'taxUnknown')}</span>
      <p>{offer.roomName ?? t('unknownRoom')}{offer.rateName && ` · ${offer.rateName}`}</p>
      <div className={styles.tags}><span>{t(offer.match)}</span>{offer.stars !== null && <span>{t('stars', { count: offer.stars })}</span>}{offer.rating !== null && <span>{offer.rating}/10</span>}<span>{t('refundable')}: {t(offer.refundable === null ? 'unknown' : offer.refundable ? 'yes' : 'no')}</span><span>{t('breakfast')}: {t(offer.breakfast === null ? 'unknown' : offer.breakfast ? 'yes' : 'no')}</span></div>
      <div className={styles.actions}><button className={styles.button} type="button" disabled={busy} onClick={onTrack}>{t('track')}</button>{booking && <a href={booking} target="_blank" rel="noopener noreferrer" className={styles.secondary}>{t('viewOffer')}</a>}</div>
    </div>
  </article>;
}
