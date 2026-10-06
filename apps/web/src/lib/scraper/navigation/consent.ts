import { errors, type Page } from 'playwright';
import { currentTravelExecution } from '../../travel/execution';

const ACCEPT_ALL = /^(?:Accept all|Tout accepter|Alles akzeptieren|Alle akzeptieren|Aceptar todo|Aceptar todos|Accetta tutto)$/i;
const SCOPED_ACCEPT = /^(?:I agree|Agree|Accept|Continue|Got it)$/i;
const CONSENT_CONTEXT = /cookie|consent|before you continue|avant de continuer|bevor sie fortfahren|antes de continuar|prima di continuare/i;

/** Generic actions require a consent name or heading and no nested dialogs. */
export async function dismissGoogleConsent(page: Page): Promise<boolean> {
  currentTravelExecution()?.check();
  const dialogs = page.getByRole('dialog', { name: CONSENT_CONTEXT }).or(
    page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: CONSENT_CONTEXT }) })
  ).filter({ hasNot: page.getByRole('dialog') });
  const button = page.getByRole('button', { name: ACCEPT_ALL }).or(
    dialogs.getByRole('button', { name: SCOPED_ACCEPT })
  ).filter({ visible: true }).first();
  try {
    await button.waitFor({ state: 'visible', timeout: 2000 });
  } catch (error) {
    currentTravelExecution()?.check();
    if (error instanceof errors.TimeoutError) return false;
    throw error;
  }
  currentTravelExecution()?.check();
  await button.click({ timeout: 2000 });
  currentTravelExecution()?.check();
  return true;
}
