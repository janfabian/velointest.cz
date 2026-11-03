/**
 * Publishes "local posts" to a Google Business Profile location via the
 * Google My Business API v4 (localPosts endpoint). Direct REST, no SDK.
 *
 * Auth is OAuth2: a long-lived refresh token (minted by scripts/auth.ts) is
 * exchanged for a short-lived access token on each run.
 *
 * Media note: GBP local posts ingest images by PUBLIC URL (sourceUrl), not by
 * file upload. Pass an https URL that Google can fetch. (See README.)
 */

export type ErrorCode = "validation" | "auth" | "permission" | "rate_limit" | "network" | "unknown";

export type CtaType = "LEARN_MORE" | "BOOK" | "ORDER" | "SHOP" | "SIGN_UP" | "CALL";
export type TopicType = "STANDARD" | "OFFER" | "EVENT" | "ALERT";

export interface LocalPostInput {
  /** Body text. Google's limit is 1500 chars; UI truncates after ~250 with "more". */
  summary: string;
  /** Language code, e.g. "cs" or "en". */
  languageCode?: string;
  /** Optional public https image URL Google will fetch. */
  imageUrl?: string;
  /** Optional call-to-action button. CALL uses the location's phone (no url). */
  cta?: { type: CtaType; url?: string };
  /** Post topic. Default STANDARD. OFFER/EVENT need extra fields not modeled here. */
  topicType?: TopicType;
}

export interface PublishResult {
  ok: boolean;
  /** localPosts/{id} name on success. */
  name?: string;
  /** "searchUrl" Google returns to view the post, when present. */
  url?: string;
  /** LIVE / PROCESSING / REJECTED as reported by Google. */
  state?: string;
  error?: string;
  errorCode?: ErrorCode;
  durationMs: number;
}

/** A local post as read back from Google. */
export interface LocalPost {
  /** Full resource name: accounts/../locations/../localPosts/ID */
  name: string;
  /** Bare post id (last path segment). */
  id: string;
  summary: string;
  state?: string;
  createTime?: string;
  updateTime?: string;
  url?: string;
  imageUrl?: string;
  cta?: { type: string; url?: string };
}

interface ApiLocalPost {
  name?: string;
  summary?: string;
  state?: string;
  createTime?: string;
  updateTime?: string;
  searchUrl?: string;
  media?: Array<{ googleUrl?: string; sourceUrl?: string }>;
  callToAction?: { actionType?: string; url?: string };
}

function toLocalPost(p: ApiLocalPost): LocalPost {
  const name = p.name || "";
  return {
    name,
    id: name.split("/").pop() || "",
    summary: p.summary || "",
    state: p.state,
    createTime: p.createTime,
    updateTime: p.updateTime,
    url: p.searchUrl,
    imageUrl: p.media?.[0]?.googleUrl || p.media?.[0]?.sourceUrl,
    cta: p.callToAction?.actionType ? { type: p.callToAction.actionType, url: p.callToAction.url } : undefined,
  };
}

export interface GbpConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accountId: string;
  locationId: string;
  defaultLang?: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MYBUSINESS_V4 = "https://mybusiness.googleapis.com/v4";
const BUSINESS_INFO_V1 = "https://mybusinessbusinessinformation.googleapis.com/v1";

export type DayOfWeek = "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY";

/** One opening interval on a single day, times as "HH:MM". */
export interface HoursPeriod {
  day: DayOfWeek;
  open: string;
  close: string;
}

interface ApiTime { hours?: number; minutes?: number }
interface ApiPeriod { openDay: DayOfWeek; openTime?: ApiTime; closeDay: DayOfWeek; closeTime?: ApiTime }

const fmtTime = (t?: ApiTime): string =>
  `${String(t?.hours ?? 0).padStart(2, "0")}:${String(t?.minutes ?? 0).padStart(2, "0")}`;
const parseTime = (s: string): ApiTime => {
  const [h, m] = s.split(":").map(Number);
  return m ? { hours: h, minutes: m } : { hours: h };
};
const fromApiPeriod = (p: ApiPeriod): HoursPeriod => ({ day: p.openDay, open: fmtTime(p.openTime), close: fmtTime(p.closeTime) });
const toApiPeriod = (p: HoursPeriod): ApiPeriod => ({
  openDay: p.day,
  openTime: parseTime(p.open),
  closeDay: p.day,
  closeTime: parseTime(p.close),
});

interface GoogleApiError {
  error?: { code?: number; message?: string; status?: string };
}

export class GbpPublisher {
  private readonly cfg: GbpConfig;
  private accessToken: string | null = null;

  constructor(cfg: GbpConfig) {
    this.cfg = cfg;
  }

  /** Exchange the refresh token for a fresh access token (cached for the run). */
  private async token(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const body = new URLSearchParams({
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      refresh_token: this.cfg.refreshToken,
      grant_type: "refresh_token",
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
    if (!res.ok || !json.access_token) {
      const e = new Error(json.error_description || json.error || `token HTTP ${res.status}`) as Error & { httpStatus?: number };
      e.httpStatus = res.status;
      throw e;
    }
    this.accessToken = json.access_token;
    return this.accessToken;
  }

  async publish(input: LocalPostInput): Promise<PublishResult> {
    const start = Date.now();
    const fail = (errorCode: ErrorCode, error: string): PublishResult => ({
      ok: false,
      error,
      errorCode,
      durationMs: Date.now() - start,
    });

    const summary = (input.summary || "").trim();
    if (!summary) return fail("validation", "post summary (text) is required");
    if (summary.length > 1500) return fail("validation", `summary too long: ${summary.length} > 1500 chars`);
    if (input.cta && input.cta.type !== "CALL" && !input.cta.url)
      return fail("validation", `CTA ${input.cta.type} requires a url`);
    if (input.imageUrl && !/^https:\/\//i.test(input.imageUrl))
      return fail("validation", "imageUrl must be a public https:// URL (GBP fetches it server-side)");

    const post: Record<string, unknown> = {
      languageCode: input.languageCode || this.cfg.defaultLang || "cs",
      summary,
      topicType: input.topicType || "STANDARD",
    };
    if (input.cta) {
      post.callToAction =
        input.cta.type === "CALL"
          ? { actionType: "CALL" }
          : { actionType: input.cta.type, url: input.cta.url };
    }
    if (input.imageUrl) {
      post.media = [{ mediaFormat: "PHOTO", sourceUrl: input.imageUrl }];
    }

    const done = (p: LocalPost): PublishResult => ({
      ok: true,
      name: p.name,
      url: p.url,
      state: p.state,
      durationMs: Date.now() - start,
    });
    const existing = await this.findJustCreated(summary);
    if (existing) return done(existing);
    try {
      const res = await this.api(this.postsPath(), "POST", post);
      return done(toLocalPost(res as ApiLocalPost));
    } catch (err) {
      // Same idea as fb/: the create may have committed before the error.
      const recovered = await this.findJustCreated(summary);
      if (recovered) return done(recovered);
      const { errorCode, message } = mapGoogleError(err);
      return fail(errorCode, message);
    }
  }

  private postsPath(): string {
    return `accounts/${this.cfg.accountId}/locations/${this.cfg.locationId}/localPosts`;
  }

  /** Accept a full "accounts/../localPosts/ID" name or the bare post id. */
  private postName(idOrName: string): string {
    const s = idOrName.trim();
    if (s.startsWith("accounts/")) return s;
    if (!/^[0-9A-Za-z_-]+$/.test(s)) throw Object.assign(new Error(`not a post id: ${idOrName}`), { httpStatus: 400 });
    return `${this.postsPath()}/${s}`;
  }

  /** Most recent local posts on the location (newest first). */
  async listPosts(limit = 5): Promise<LocalPost[]> {
    const res = await this.api(`${this.postsPath()}?pageSize=${Math.min(Math.max(limit, 1), 100)}`, "GET");
    return ((res.localPosts as ApiLocalPost[] | undefined) || []).map(toLocalPost);
  }

  async getPost(idOrName: string): Promise<LocalPost> {
    return toLocalPost((await this.api(this.postName(idOrName), "GET")) as ApiLocalPost);
  }

  /** Replace a post's text. Image / button are left as they are. */
  async editPost(idOrName: string, summary: string): Promise<LocalPost> {
    const text = summary.trim();
    if (!text) throw Object.assign(new Error("post text is required"), { httpStatus: 400 });
    if (text.length > 1500) throw Object.assign(new Error(`text too long: ${text.length} > 1500 chars`), { httpStatus: 400 });
    const res = await this.api(`${this.postName(idOrName)}?updateMask=summary`, "PATCH", { summary: text });
    return toLocalPost(res as ApiLocalPost);
  }

  async deletePost(idOrName: string): Promise<void> {
    await this.api(this.postName(idOrName), "DELETE");
  }

  /**
   * Duplicate guard: a post with exactly this text created in the last few
   * minutes (e.g. by a previous run that errored on the response path).
   */
  async findJustCreated(summary: string, withinMs = 5 * 60 * 1000): Promise<LocalPost | null> {
    try {
      const cutoff = Date.now() - withinMs;
      for (const p of await this.listPosts(5)) {
        if (p.summary === summary.trim() && p.createTime && Date.parse(p.createTime) >= cutoff) return p;
      }
    } catch {
      /* best-effort only */
    }
    return null;
  }

  /** Read the location's title — a cheap liveness/permission probe. */
  async check(): Promise<{ ok: true; title: string } | { ok: false; error: string; errorCode: ErrorCode }> {
    try {
      // Business Information API for the human-readable title.
      const token = await this.token();
      const url = `https://mybusinessbusinessinformation.googleapis.com/v1/locations/${this.cfg.locationId}?readMask=title,storefrontAddress`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const json = (await res.json().catch(() => ({}))) as { title?: string } & GoogleApiError;
      if (!res.ok) {
        const e = new Error(json.error?.message || `HTTP ${res.status}`) as Error & { httpStatus?: number; status?: string };
        e.httpStatus = res.status;
        e.status = json.error?.status;
        throw e;
      }
      return { ok: true, title: json.title || `location ${this.cfg.locationId}` };
    } catch (err) {
      const { errorCode, message } = mapGoogleError(err);
      return { ok: false, error: message, errorCode };
    }
  }

  /** Read the location's regular (weekly) opening hours. */
  async getHours(): Promise<{ ok: true; periods: HoursPeriod[] } | { ok: false; error: string; errorCode: ErrorCode }> {
    try {
      const json = await this.infoApi(`locations/${this.cfg.locationId}?readMask=regularHours`, "GET");
      const rh = json.regularHours as { periods?: ApiPeriod[] } | undefined;
      return { ok: true, periods: (rh?.periods || []).map(fromApiPeriod) };
    } catch (err) {
      const { errorCode, message } = mapGoogleError(err);
      return { ok: false, error: message, errorCode };
    }
  }

  /** Replace the location's regular opening hours. Days without a period show as closed. */
  async setHours(periods: HoursPeriod[]): Promise<{ ok: true; periods: HoursPeriod[] } | { ok: false; error: string; errorCode: ErrorCode }> {
    try {
      const json = await this.infoApi(`locations/${this.cfg.locationId}?updateMask=regularHours`, "PATCH", {
        regularHours: { periods: periods.map(toApiPeriod) },
      });
      const rh = json.regularHours as { periods?: ApiPeriod[] } | undefined;
      return { ok: true, periods: (rh?.periods || []).map(fromApiPeriod) };
    } catch (err) {
      const { errorCode, message } = mapGoogleError(err);
      return { ok: false, error: message, errorCode };
    }
  }

  private async infoApi(path: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
    const token = await this.token();
    const res = await fetch(`${BUSINESS_INFO_V1}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & GoogleApiError;
    if (!res.ok) {
      const e = new Error(json.error?.message || `Business Information API HTTP ${res.status}`) as Error & {
        httpStatus?: number;
        status?: string;
      };
      e.httpStatus = res.status;
      e.status = json.error?.status;
      throw e;
    }
    return json;
  }

  private async api(path: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
    const token = await this.token();
    const res = await fetch(`${MYBUSINESS_V4}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & GoogleApiError;
    if (!res.ok) {
      const e = new Error(json.error?.message || `My Business API HTTP ${res.status}`) as Error & {
        httpStatus?: number;
        status?: string;
      };
      e.httpStatus = res.status;
      e.status = json.error?.status;
      throw e;
    }
    return json;
  }
}

export function mapGoogleError(err: unknown): { errorCode: ErrorCode; message: string } {
  const e = err as { httpStatus?: number; status?: string; message?: string };
  const message = typeof e?.message === "string" ? e.message : String(err ?? "unknown error");
  const s = e?.status;
  if (s === "PERMISSION_DENIED" || e?.httpStatus === 403) return { errorCode: "permission", message };
  if (s === "UNAUTHENTICATED" || e?.httpStatus === 401) return { errorCode: "auth", message };
  if (s === "RESOURCE_EXHAUSTED" || e?.httpStatus === 429) return { errorCode: "rate_limit", message };
  if (s === "INVALID_ARGUMENT" || (e?.httpStatus && e.httpStatus >= 400 && e.httpStatus < 500))
    return { errorCode: "validation", message };
  if (e?.httpStatus === undefined && /(ECONN|ETIMEDOUT|ENOTFOUND|fetch failed|network)/i.test(message))
    return { errorCode: "network", message };
  return { errorCode: "unknown", message };
}
