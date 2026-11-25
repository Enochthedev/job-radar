export interface RawJob {
  source: string;
  externalId: string;
  url: string;
  company: string;
  companyDomain?: string | null;
  title: string;
  locationRaw?: string | null;
  /** Explicit structured restrictions from the board, if it has them. */
  locationRestrictions?: string[];
  timezoneRestrictions?: number[];
  salaryMin?: number | null;
  salaryMax?: number | null;
  currency?: string | null;
  salaryPeriod?: "year" | "month" | "hour" | null;
  tags?: string[];
  description?: string | null; // plain text
  postedAt?: Date | null;
  isYc?: boolean;
  onWatchlist?: boolean;
}

export interface SourceAdapter {
  name: string;
  /** Poll interval in hours. */
  everyHours: number;
  fetch(): Promise<RawJob[]>;
}
