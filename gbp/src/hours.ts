#!/usr/bin/env bun
/**
 * CLI: show or replace the regular (weekly) opening hours on the Google
 * Business Profile location. Uses the Business Information API v1.
 *
 * Examples:
 *   bun run hours                                            # show current hours
 *   bun run hours --set "MON,WED 11:00-17:00; TUE,THU 11:00-18:00" --dry-run
 *   bun run hours --set "MON,WED 11:00-17:00; TUE,THU 11:00-18:00"
 *   bun run hours --json
 *
 * --set REPLACES the whole week: any day not listed shows as closed on Google.
 * Day codes: MON TUE WED THU FRI SAT SUN (also Czech PO UT ST CT PA SO NE).
 * Several intervals on one day (lunch break): "MON 09:00-12:00; MON 13:00-17:00".
 */
import { GbpPublisher, type DayOfWeek, type HoursPeriod } from "./gbp.ts";

const DAY: Record<string, DayOfWeek> = {
  MON: "MONDAY", TUE: "TUESDAY", WED: "WEDNESDAY", THU: "THURSDAY", FRI: "FRIDAY", SAT: "SATURDAY", SUN: "SUNDAY",
  PO: "MONDAY", UT: "TUESDAY", ST: "WEDNESDAY", CT: "THURSDAY", PA: "FRIDAY", SO: "SATURDAY", NE: "SUNDAY",
};
const ORDER: DayOfWeek[] = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(2);
}

export function parseSpec(spec: string): HoursPeriod[] {
  const out: HoursPeriod[] = [];
  for (const chunk of spec.split(";").map((c) => c.trim()).filter(Boolean)) {
    const m = chunk.match(/^([A-Za-z,\s]+?)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
    if (!m) die(`can't parse "${chunk}" — expected e.g. "MON,WED 11:00-17:00"`);
    const [, days, open, close] = m;
    const norm = (t: string) => {
      const [h, mm] = t.split(":").map(Number);
      if (h! > 24 || mm! > 59) die(`bad time "${t}"`);
      return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    };
    if (norm(open!) >= norm(close!)) die(`"${chunk}": close must be after open`);
    for (const d of days!.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean)) {
      const day = DAY[d];
      if (!day) die(`unknown day "${d}"`);
      out.push({ day, open: norm(open!), close: norm(close!) });
    }
  }
  if (!out.length) die("--set needs at least one interval");
  return out.sort((a, b) => ORDER.indexOf(a.day) - ORDER.indexOf(b.day) || a.open.localeCompare(b.open));
}

export function formatWeek(periods: HoursPeriod[]): string {
  return ORDER.map((d) => {
    const ps = periods.filter((p) => p.day === d);
    const label = d.slice(0, 1) + d.slice(1).toLowerCase();
    return `  ${label.padEnd(10)} ${ps.length ? ps.map((p) => `${p.open}–${p.close}`).join(", ") : "closed"}`;
  }).join("\n");
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let spec: string | undefined;
  let json = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--set") spec = argv[++i] ?? die("missing value for --set");
    else if (a.startsWith("--set=")) spec = a.slice(6);
    else if (a === "--json") json = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log('usage: bun run hours [--set "MON,WED 11:00-17:00; TUE,THU 11:00-18:00"] [--dry-run] [--json]');
      process.exit(0);
    } else die(`unknown argument ${a}`);
  }

  const periods = spec ? parseSpec(spec) : undefined;
  if (periods && dryRun) {
    if (json) console.log(JSON.stringify({ ok: true, dryRun: true, periods }));
    else console.log(`dry run — would set:\n${formatWeek(periods)}`);
    process.exit(0);
  }

  const env = process.env;
  for (const k of ["GBP_CLIENT_ID", "GBP_CLIENT_SECRET", "GBP_REFRESH_TOKEN", "GBP_ACCOUNT_ID", "GBP_LOCATION_ID"])
    if (!env[k]) die(`missing ${k} in environment (.env) — run 'bun run auth' first`);
  const gbp = new GbpPublisher({
    clientId: env.GBP_CLIENT_ID!,
    clientSecret: env.GBP_CLIENT_SECRET!,
    refreshToken: env.GBP_REFRESH_TOKEN!,
    accountId: env.GBP_ACCOUNT_ID!,
    locationId: env.GBP_LOCATION_ID!,
  });

  const res = periods ? await gbp.setHours(periods) : await gbp.getHours();
  if (json) console.log(JSON.stringify(res));
  else if (res.ok) console.log(`${periods ? "✓ updated. Google now has:" : "current hours on Google:"}\n${formatWeek(res.periods)}`);
  else console.error(`✗ ${res.errorCode}: ${res.error}`);
  process.exit(res.ok ? 0 : 1);
}
