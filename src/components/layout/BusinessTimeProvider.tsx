'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { TZ_NAME } from '@/lib/constants';
import { formatBusinessDateTime, today } from '@/lib/date';

interface BusinessTimeValue {
  timeZone: string;
  businessDate: string;
}

const fallbackDate = today();
const BusinessTimeContext = createContext<BusinessTimeValue>({
  timeZone: TZ_NAME,
  businessDate: fallbackDate,
});

export function BusinessTimeProvider({
  timeZone,
  businessDate,
  children,
}: BusinessTimeValue & { children: ReactNode }) {
  return (
    <BusinessTimeContext.Provider value={{ timeZone, businessDate }}>
      {children}
    </BusinessTimeContext.Provider>
  );
}

export function useBusinessToday(): string {
  return useContext(BusinessTimeContext).businessDate;
}

export function useBusinessTimeZone(): string {
  return useContext(BusinessTimeContext).timeZone;
}

export function useBusinessDateTimeFormatter(): (iso: string) => string {
  const timeZone = useBusinessTimeZone();
  return (iso: string) => formatBusinessDateTime(iso, timeZone);
}
