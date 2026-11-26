import { TZ_NAME } from '@/lib/constants';
import { isValidTimeZone, today } from '@/lib/date';
import { getProfile } from '@/lib/queries/profile';

export async function getBusinessTimezone(): Promise<string> {
  const profile = await getProfile();
  return isValidTimeZone(profile.timezone) ? profile.timezone : TZ_NAME;
}

export async function businessToday(): Promise<string> {
  return today(new Date(), await getBusinessTimezone());
}

export async function resolveBusinessDate(value?: string): Promise<string> {
  return value ?? businessToday();
}
