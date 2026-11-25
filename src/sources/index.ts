import { loadProfile } from "../profile.js";
import { careersAdapter } from "./ats.js";
import { hn } from "./hn.js";
import { himalayas } from "./himalayas.js";
import { remoteok } from "./remoteok.js";
import { remotive } from "./remotive.js";
import type { SourceAdapter } from "./types.js";
import { wwr } from "./wwr.js";

export function adapters(): SourceAdapter[] {
  return [hn, remoteok, remotive, himalayas, wwr, careersAdapter(loadProfile().watchlist)];
}

export function adapter(name: string): SourceAdapter | undefined {
  return adapters().find((a) => a.name === name);
}
