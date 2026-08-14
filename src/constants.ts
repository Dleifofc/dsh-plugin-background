/**
 * src/constants.ts — areas, modes, defaults, shared helpers.
 */
import type { AreaConfig, AreaId, DisplayMode, GroupDef, ImageConfig, MediaType, RepeatMode, SurfaceId } from "./types";

/** Built-in backgroundable surfaces. Better-sidebar tabs are dynamic surfaces
 * (panel-right:<title> / panel-bottom:<title>) discovered at runtime. */
export const AREAS: readonly AreaId[] = Object.freeze(["conversation", "trajectory", "sidebar", "settings"]);

/** Quick display modes for an image. */
export const MODES: readonly DisplayMode[] = Object.freeze(["cover", "contain", "fill", "repeat", "center", "custom"]);

/** Repeat choices for custom mode (images only). */
export const REPEATS: readonly RepeatMode[] = Object.freeze(["no-repeat", "repeat", "repeat-x", "repeat-y"]);

/** localStorage key holding the persisted per-area background config. */
export const STORAGE_KEY = "dsh.background";

/** IndexedDB database holding local media blobs (no base64 packing). */
export const IDB_NAME = "dsh-plugin-background";
export const IDB_STORE = "files";

/** Slideshow tick period in ms. */
export const TICK_MS = 1000;

/** Default per-image display configuration (opacity/blur are per image). */
export const DEFAULT_IMAGE: ImageConfig = Object.freeze({
	source: "url",
	url: "",
	fileId: "",
	name: "",
	media: "image",
	mode: "cover",
	posX: "50%",
	posY: "50%",
	scale: 100,
	width: "",
	height: "",
	repeat: "no-repeat",
	rotate: 0,
	radius: 0,
	opacity: 0.9,
	blur: 0
});

/** Default area configuration (no images — the user supplies them). */
export const DEFAULT_AREA: AreaConfig = Object.freeze({
	enabled: false,
	images: [],
	intervalSec: 15,
	random: false
});

/** Build a fresh default state over the built-in surfaces. */
export function defaultState(): { areas: Record<SurfaceId, AreaConfig>; groups: GroupDef[] } {
	const areas = {} as Record<SurfaceId, AreaConfig>;
	for (const area of AREAS) areas[area] = { ...DEFAULT_AREA, images: [] as ImageConfig[] };
	return { areas, groups: [] };
}

/** Default state: every surface off until the user configures images. */
export const DEFAULT_STATE = Object.freeze(defaultState());

/** Stable short hash of a surface id (tab titles carry arbitrary characters
 * that cannot appear in CSS identifiers / attribute names). */
export function surfaceHash(id: string): string {
	let h = 5381;
	for (let i = 0; i < id.length; i++) h = ((h * 33) ^ id.charCodeAt(i)) >>> 0;
	return h.toString(36);
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** Escape a string for embedding inside a quoted CSS url(). */
export function escapeCssString(value: string): string {
	return value.replace(/["\\]/g, (ch) => `\\${ch}`);
}

/** Split a user-entered list (commas / semicolons / newlines) into trimmed URLs. */
export function parseImageList(raw: string): string[] {
	return raw.split(/[,;\n]/).map((item) => item.trim()).filter((item) => item !== "");
}

/** Video file extensions the plugin recognizes (played muted, no sound). */
const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|m4v|ogv)(?:[?#].*)?$/i;

/** Guess a media kind from a URL or file name. GIFs stay "image" (browsers
 * animate background-image GIFs natively). */
export function mediaOfName(name: string): MediaType {
	return VIDEO_EXTENSIONS.test(name) ? "video" : "image";
}

/** Build a fresh per-image config over a URL. */
export function imageOfUrl(url: string): ImageConfig {
	return { ...DEFAULT_IMAGE, source: "url", url, media: mediaOfName(url) };
}

/** Build a fresh per-image config over a stored local file. */
export function imageOfFile(fileId: string, name: string, media: MediaType): ImageConfig {
	return { ...DEFAULT_IMAGE, source: "file", fileId, name, media };
}

/** Generate a unique id for IndexedDB keys. */
export function makeId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
