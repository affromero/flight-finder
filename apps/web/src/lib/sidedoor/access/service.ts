import {
  AccessService,
  HouseholdProfileService,
} from "thesidedoor-core/access";
import { FlightFinderAccessStore } from "./access-store";

export const SHARED_SESSION_COOKIE = "ft-session";
const sessionAge = Number(process.env.SESSION_MAX_AGE);
export const sharedAccessStore = new FlightFinderAccessStore();
export const sharedAccess = new AccessService({
  store: sharedAccessStore,
  sessionTtlMs:
    Number.isFinite(sessionAge) && sessionAge > 0
      ? sessionAge * 1000
      : 7 * 24 * 60 * 60 * 1000,
  householdSessionTtlMs: 12 * 60 * 60 * 1000,
  allowPrincipalAccessInHousehold: process.env.SELF_HOSTED !== "true",
});
export const sharedProfiles = new HouseholdProfileService(sharedAccess);
