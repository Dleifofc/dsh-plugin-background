/**
 * src/types.ts — shared domain types for the background plugin.
 */

/**
 * Shell areas, each with an independent image group:
 * - conversation: the conversation surface (message list + composer)
 * - trajectory: the trajectory view surface (conversation view tab)
 * - sidebar: the left sidebar column
 * - settings: the settings dialog panel
 */
export type AreaId = "conversation" | "trajectory" | "sidebar" | "settings";

/** Quick display modes for an image. */
export type DisplayMode = "cover" | "contain" | "fill" | "repeat" | "center" | "custom";

/** Repeat choices for custom mode. */
export type RepeatMode = "no-repeat" | "repeat" | "repeat-x" | "repeat-y";

/** Image source: a remote/pasted URL, or a local file stored in IndexedDB. */
export type ImageSource = "url" | "file";

/** Media kind: static image (incl. animated GIFs) or video. */
export type MediaType = "image" | "video";

/**
 * Per-image configuration: display mode + detailed parameters plus the
 * image's own rendering options (opacity / blur are per image, not per area).
 */
export interface ImageConfig {
	source: ImageSource;
	/** URL source: the image URL. */
	url: string;
	/** File source: IndexedDB key of the stored Blob. */
	fileId: string;
	/** File source: original file name (display only). */
	name: string;
	/** Media kind: videos render through a muted looping <video> layer. */
	media: MediaType;
	/** Quick display mode. */
	mode: DisplayMode;
	/** Custom-mode position, e.g. "20% 80%" or "120px 40px". */
	posX: string;
	posY: string;
	/** Custom-mode scale in percent (10–500). */
	scale: number;
	/** Custom-mode explicit width ("auto" when empty), px or %. */
	width: string;
	/** Custom-mode explicit height ("auto" when empty), px or %. */
	height: string;
	/** Custom-mode repeat (images only; videos ignore it). */
	repeat: RepeatMode;
	/** Layer rotation in degrees (-180..180). */
	rotate: number;
	/** Layer corner radius in px (0..200). */
	radius: number;
	/** This image's layer opacity (0..1). */
	opacity: number;
	/** This image's layer blur in px (0..24). */
	blur: number;
}

/** Per-area configuration. */
export interface AreaConfig {
	enabled: boolean;
	images: ImageConfig[];
	/** Slideshow interval in seconds; 0 pauses playback. */
	intervalSec: number;
	/** Order vs random playback. */
	random: boolean;
}

/** Persisted state (localStorage), plus runtime playback position. */
export interface BackgroundState {
	areas: Record<AreaId, AreaConfig>;
}

/** Immutable snapshot handed to the settings store / UI. */
export interface BackgroundSnapshot extends BackgroundState {
	/** Current playback index per area (runtime, not persisted). */
	index: Record<AreaId, number>;
	/** Last persistence error key ("quota" etc.), null when fine. */
	lastError: string | null;
	revision: number;
}

/** Resolved CSS values for one image. */
export interface DisplayValues {
	size: string;
	position: string;
	repeat: string;
	rotate: string;
	radius: string;
}
