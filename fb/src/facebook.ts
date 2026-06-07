import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

export type MediaKind = "image" | "video";

export interface MediaItem {
  path: string;
  kind: MediaKind;
}

export interface Post {
  text: string;
  link?: string;
  media?: MediaItem[];
}

export type ErrorCode = "validation" | "auth" | "rate_limit" | "network" | "unknown";

export type PublishResult =
  | { ok: true; postId: string; url: string; durationMs: number }
  | { ok: false; error: string; errorCode: ErrorCode; durationMs: number };

export interface FacebookConfig {
  pageId: string;
  pageAccessToken: string;
  graphVersion?: string;
  /** Publish a single video as a Reel (3-phase upload). Reels get more reach. Default true. */
  reels?: boolean;
  /** Max image bytes (default 15 MiB). */
  imageMaxBytes?: number;
  /** Max video bytes (default 512 MiB). */
  videoMaxBytes?: number;
}

const DEFAULT_IMAGE_MAX = 15 * 1024 * 1024;
const DEFAULT_VIDEO_MAX = 512 * 1024 * 1024;
const VALID_IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const VALID_VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm"]);

interface GraphError {
  message?: string;
  code?: number;
  type?: string;
}

/**
 * Post to a Facebook Page via the Graph API.
 *  - text / link        -> POST /{page}/feed
 *  - single image       -> POST /{page}/photos
 *  - multiple images    -> /photos uploads (unpublished) + /feed attached_media
 *  - single video       -> Reel via /video_reels (default) OR /videos
 */
export class FacebookPublisher {
  private readonly graphBase: string;
  private readonly pageId: string;
  private readonly token: string;
  private readonly imageMax: number;
  private readonly videoMax: number;
  private readonly reels: boolean;

  constructor(cfg: FacebookConfig) {
    this.graphBase = `https://graph.facebook.com/${cfg.graphVersion || "v21.0"}`;
    this.pageId = cfg.pageId;
    this.token = cfg.pageAccessToken;
    this.imageMax = cfg.imageMaxBytes ?? DEFAULT_IMAGE_MAX;
    this.videoMax = cfg.videoMaxBytes ?? DEFAULT_VIDEO_MAX;
    this.reels = cfg.reels ?? true;
  }

  async publish(post: Post): Promise<PublishResult> {
    const start = Date.now();
    const fail = (errorCode: ErrorCode, error: string): PublishResult => ({
      ok: false,
      error,
      errorCode,
      durationMs: Date.now() - start,
    });
    const ok = async (postId: string, urlOverride?: string): Promise<PublishResult> => ({
      ok: true,
      postId,
      url: urlOverride ?? (await this.permalinkUrl(postId)) ?? `https://www.facebook.com/${postId}`,
      durationMs: Date.now() - start,
    });

    const media = post.media ?? [];
    const videos = media.filter((m) => m.kind === "video");
    const images = media.filter((m) => m.kind === "image");

    if (videos.length > 1) return fail("validation", `Facebook allows 1 video per post (got ${videos.length})`);
    if (videos.length === 1 && images.length > 0)
      return fail("validation", "Facebook does not allow mixing a video with images");
    for (const item of media) {
      const v = this.validate(item);
      if (!v.ok) return fail("validation", v.reason);
    }
    if (!post.text && media.length === 0 && !post.link)
      return fail("validation", "post must contain text, media, or a link");

    // Duplicate guard for cross-invocation retries: if an identical post was
    // created on the page within the last few minutes (e.g. a previous run
    // that "failed" on the response path but committed server-side), return
    // it instead of posting again.
    if (post.text) {
      const existing = await this.findJustCreatedPost(post.text);
      if (existing) return await ok(existing);
    }

    try {
      if (videos.length === 1) {
        const video = videos[0]!;
        if (this.reels) {
          const reelId = await this.publishReel(video, post.text);
          return ok(reelId, `https://www.facebook.com/reel/${reelId}`);
        }
        const fd = this.form({ description: post.text });
        appendFile(fd, "source", video);
        const res = await this.graph(`${this.pageId}/videos`, fd);
        return await ok(String(res.id));
      }
      if (images.length === 1) {
        const fd = this.form({ message: post.text });
        appendFile(fd, "source", images[0]!);
        const res = await this.graph(`${this.pageId}/photos`, fd);
        return await ok(String(res.post_id ?? res.id));
      }
      if (images.length > 1) {
        const fbids: string[] = [];
        for (const img of images) {
          const fd = this.form({ published: "false" });
          appendFile(fd, "source", img);
          const up = await this.graph(`${this.pageId}/photos`, fd);
          fbids.push(String(up.id));
        }
        const body = this.params({ message: post.text });
        fbids.forEach((id, i) => body.set(`attached_media[${i}]`, JSON.stringify({ media_fbid: id })));
        const res = await this.graph(`${this.pageId}/feed`, body);
        return await ok(String(res.id));
      }
      // Text / link only
      const body = this.params({ message: post.text });
      if (post.link) body.set("link", post.link);
      const res = await this.graph(`${this.pageId}/feed`, body);
      return await ok(String(res.id));
    } catch (err) {
      // The Graph API sometimes commits the post server-side and THEN fails on
      // the response path (seen live: "Please reduce the amount of data you're
      // asking for" after a successful multi-photo /feed create). Reporting
      // failure here invites a blind retry → duplicate post. Before failing,
      // check whether a post with this exact text just appeared on the page;
      // if so, the publish actually succeeded — return it as success.
      if (post.text) {
        const recovered = await this.findJustCreatedPost(post.text);
        if (recovered) return await ok(recovered);
      }
      const { errorCode, message } = mapFbError(err);
      return fail(errorCode, message);
    }
  }

  /**
   * Duplicate guard: look for a post on the page whose message matches `text`
   * exactly and was created within the last few minutes. Returns its id, or
   * null. Swallows its own errors (it's a best-effort recovery probe).
   */
  private async findJustCreatedPost(text: string): Promise<string | null> {
    try {
      const res = await this.graph(
        `${this.pageId}/posts?fields=id,message,created_time&limit=5&access_token=${encodeURIComponent(this.token)}`,
        undefined,
        "GET",
      );
      const posts = (res.data ?? []) as Array<{ id?: string; message?: string; created_time?: string }>;
      const cutoff = Date.now() - 5 * 60 * 1000;
      for (const p of posts) {
        if (!p.id || (p.message ?? "") !== text) continue;
        const created = p.created_time ? Date.parse(p.created_time) : NaN;
        if (!isNaN(created) && created >= cutoff) return p.id;
      }
    } catch {
      /* best-effort only */
    }
    return null;
  }

  /** Best-effort liveness probe: read the Page's name. */
  async check(): Promise<{ ok: true; name: string } | { ok: false; error: string; errorCode: ErrorCode }> {
    try {
      const res = await this.graph(
        `${this.pageId}?fields=name&access_token=${encodeURIComponent(this.token)}`,
        undefined,
        "GET",
      );
      return { ok: true, name: typeof res.name === "string" ? res.name : `page ${this.pageId}` };
    } catch (err) {
      const { errorCode, message } = mapFbError(err);
      return { ok: false, error: message, errorCode };
    }
  }

  // --- internals ---

  private validate(item: MediaItem): { ok: true } | { ok: false; reason: string } {
    let size: number;
    try {
      size = statSync(item.path).size;
    } catch (e) {
      return { ok: false, reason: `cannot stat ${item.path}: ${(e as Error).message}` };
    }
    const ext = extname(item.path).toLowerCase();
    if (item.kind === "image") {
      if (!VALID_IMAGE_EXT.has(ext)) return { ok: false, reason: `unsupported image type: ${ext}` };
      if (size > this.imageMax) return { ok: false, reason: `image too large: ${size} > ${this.imageMax} bytes` };
    } else {
      if (!VALID_VIDEO_EXT.has(ext)) return { ok: false, reason: `unsupported video type: ${ext}` };
      if (size > this.videoMax) return { ok: false, reason: `video too large: ${size} > ${this.videoMax} bytes` };
    }
    return { ok: true };
  }

  private async publishReel(video: MediaItem, description: string): Promise<string> {
    const startRes = await this.graph(
      `${this.pageId}/video_reels`,
      this.params({ upload_phase: "start" }),
    );
    const videoId = String(startRes.video_id ?? "");
    const uploadUrl = String(startRes.upload_url ?? "");
    if (!videoId || !uploadUrl) throw new Error("Reels start phase did not return video_id/upload_url");

    const buf = readFileSync(video.path);
    const up = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `OAuth ${this.token}`,
        offset: "0",
        file_size: String(buf.byteLength),
      },
      body: buf,
    });
    if (!up.ok) {
      const j = (await up.json().catch(() => ({}))) as { error?: GraphError };
      const e = new Error(j?.error?.message ?? `Reels upload HTTP ${up.status}`) as Error & {
        code?: number;
        httpStatus?: number;
      };
      e.code = j?.error?.code;
      e.httpStatus = up.status;
      throw e;
    }

    await this.graph(
      `${this.pageId}/video_reels`,
      this.params({
        upload_phase: "finish",
        video_id: videoId,
        video_state: "PUBLISHED",
        description,
      }),
    );
    return videoId;
  }

  /** Look up a post's canonical permalink_url; falls back silently on failure. */
  private async permalinkUrl(postId: string): Promise<string | undefined> {
    try {
      const res = await this.graph(
        `${postId}?fields=permalink_url&access_token=${encodeURIComponent(this.token)}`,
        undefined,
        "GET",
      );
      if (typeof res.permalink_url === "string") return res.permalink_url;
    } catch {
      /* swallow */
    }
    return undefined;
  }

  private params(fields: Record<string, string>): URLSearchParams {
    const p = new URLSearchParams(fields);
    p.set("access_token", this.token);
    return p;
  }

  private form(fields: Record<string, string>): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    fd.set("access_token", this.token);
    return fd;
  }

  private async graph(
    path: string,
    body: URLSearchParams | FormData | undefined,
    method: "GET" | "POST" = "POST",
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.graphBase}/${path}`, { method, body });
    const json = (await res.json().catch(() => ({}))) as { error?: GraphError } & Record<string, unknown>;
    if (!res.ok) {
      const ge = json?.error ?? {};
      const e = new Error(ge.message ?? `Graph API HTTP ${res.status}`) as Error & {
        code?: number;
        httpStatus?: number;
      };
      e.code = ge.code;
      e.httpStatus = res.status;
      throw e;
    }
    return json;
  }
}

function appendFile(fd: FormData, field: string, item: MediaItem): void {
  const buf = readFileSync(item.path);
  fd.set(field, new Blob([buf]), basename(item.path));
}

export function mapFbError(err: unknown): { errorCode: ErrorCode; message: string } {
  const e = err as { code?: number; httpStatus?: number; message?: string };
  const message = typeof e?.message === "string" ? e.message : String(err ?? "unknown error");
  const code = e?.code;
  if (code === 190 || code === 200 || code === 10 || code === 102) return { errorCode: "auth", message };
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 80001)
    return { errorCode: "rate_limit", message };
  if (e?.httpStatus === 401 || e?.httpStatus === 403) return { errorCode: "auth", message };
  if (e?.httpStatus && e.httpStatus >= 400 && e.httpStatus < 500) return { errorCode: "validation", message };
  if (e?.httpStatus === undefined && /(ECONN|ETIMEDOUT|ENOTFOUND|fetch failed|network)/i.test(message))
    return { errorCode: "network", message };
  return { errorCode: "unknown", message };
}
