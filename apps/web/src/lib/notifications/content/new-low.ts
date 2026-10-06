import { formatCurrency } from '@/lib/currency';

export interface NewLowText {
  origin: string;
  destination: string;
  currentMin: number;
  baseline: number;
  drop: number;
  currency: string | null;
  airline: string;
  travelDate: string;
}

export function newLowText(data: NewLowText, locale: 'en' | 'es' | 'pt' | 'de' | 'fr' = 'en') {
  const current = formatCurrency(data.currentMin, data.currency), baseline = formatCurrency(data.baseline, data.currency), drop = formatCurrency(data.drop, data.currency);
  const { origin, destination, airline, travelDate } = data;
  switch (locale) {
    case 'es': return { title: `Nuevo mínimo: ${origin} a ${destination} ${current}`, body: `${origin} a ${destination} bajó a ${current} con ${airline} (antes ${baseline}, ahorro de ${drop}). Fecha de viaje ${travelDate}.` };
    case 'pt': return { title: `Novo mínimo: ${origin} para ${destination} ${current}`, body: `${origin} para ${destination} caiu para ${current} com ${airline} (antes ${baseline}, economia de ${drop}). Data da viagem ${travelDate}.` };
    case 'de': return { title: `Neuer Tiefstpreis: ${origin} nach ${destination} ${current}`, body: `${origin} nach ${destination} kostet jetzt ${current} mit ${airline} (vorher ${baseline}, Ersparnis ${drop}). Reisedatum ${travelDate}.` };
    case 'fr': return { title: `Nouveau minimum : ${origin} vers ${destination} ${current}`, body: `${origin} vers ${destination} est passé à ${current} avec ${airline} (auparavant ${baseline}, économie de ${drop}). Date du voyage ${travelDate}.` };
    case 'en': return { title: `New low: ${origin} to ${destination} ${current}`, body: `${origin} to ${destination} dropped to ${current} on ${airline} (was ${baseline}, down ${drop}). Travel date ${travelDate}.` };
  }
}
