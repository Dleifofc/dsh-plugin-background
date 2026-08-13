/**
 * src/service.ts — BackgroundService: owns the persisted per-area state
 * (media groups + per-image display/rendering config + slideshow playback),
 * paints each area's layer pair, and emits `background/change` snapshots.
 *
 * Areas: conversation (message surface), trajectory (trajectory
 * view), sidebar (left column), settings (settings dialog). Each area owns TWO stacked layer elements (a/b) so media switches
 * can crossfade: the incoming layer fades in while the outgoing one fades
 * out. Every layer hosts exactly one media child — a background-image div for
 * images/GIFs or a muted looping <video> for videos.
 *
 * Switches are preloaded and crossfaded: the next media is fetched early
 * (half an interval ahead), and the switch only lands once the media has
 * actually loaded — the interval is allowed to overrun rather than flash an
 * empty layer. The crossfade itself is driven by the Web Animations API
 * (`Element.animate`), not by CSS transitions, so it runs regardless of
 * shell stylesheet overrides and can be retargeted mid-fade. A switch to
 * the SAME media (single-image areas, per-image tweaks) repaints in place
 * without any fade. Each area's group holds ONE media kind — images switch
 * like a slideshow, videos play; mixed groups are not supported. Local
 * files live in IndexedDB as raw bytes and display through lazily-created
 * object URLs (cached and revoked here). Opacity and blur are per image,
 * not per area.
 */
import { AREAS, TICK_MS, clamp, escapeCssString } from "./constants";
import { resolveDisplay, videoFitOf } from "./display";
import { deleteStoredFile } from "./files";
import { idbGetFile, persistState, restoreState } from "./persistence";
import type { AreaId, BackgroundSnapshot, BackgroundState, ImageConfig, MediaType } from "./types";

/** Cordis context subset the service needs. */
export interface BackgroundCtx {
	effect(callback: () => void | (() => void), label?: string): () => void;
	emit(event: string, payload?: unknown): void;
}

/** Outcome of adding media to an area. A group holds ONE media kind — images
 * switch like a slideshow, videos play — mixed batches are filtered to the
 * group's kind and the leftovers reported here for the editor UI. */
export interface AddImagesResult {
	added: number;
	/** Count of configs skipped because their kind differs from the group's. */
	skipped: number;
	/** Media kind of the skipped configs (undefined when nothing was skipped). */
	skippedKind?: MediaType;
}

/** Crossfade duration and settle wait. The fade is WAAPI-driven; the settle
 * wait leaves a margin after the fade completes before the outgoing layer
 * is cleaned up. */
const FADE_MS = 450;
const FADE_SETTLE_MS = FADE_MS + 80;

/** Which physical layer element is which. */
type LayerIndex = 0 | 1;

/** Build a fresh per-area record. */
function perArea<T>(init: () => T): Record<AreaId, T> {
	const rec = {} as Record<AreaId, T>;
	for (const area of AREAS) rec[area] = init();
	return rec;
}

export class BackgroundService {
	private ctx: BackgroundCtx;
	private state: BackgroundState;
	private index = perArea<number>(() => 0);
	private elapsed = perArea<number>(() => 0);
	private lastError: string | null = null;
	private revision = 0;
	private snapshot: BackgroundSnapshot;
	/** fileId -> object URL cache for local media. */
	private objectUrls = new Map<string, string>();
	/** URL -> preload promise cache (shared across prewarm/switch). */
	private preloadCache = new Map<string, Promise<boolean>>();
	/** Currently visible layer per area. */
	private activeLayer = perArea<LayerIndex>(() => 0);
	/** Layer elements projected at least once (painted or explicitly hidden).
	 * A freshly created element has no inline opacity, so the CSS default
	 * opacity 1 plus its fallback background-color would cover the pair
	 * until the service initializes it. */
	private projectedLayers = new WeakSet<HTMLElement>();
	/** Last media painted per area (same-media compare for no-fade repaints). */
	private lastPainted = perArea<ImageConfig | undefined | null>(() => null);
	private paintedOnce = perArea<boolean>(() => false);
	private fadeTimers = perArea<ReturnType<typeof setTimeout> | undefined>(() => undefined);
	/** Running WAAPI fade animations per area per layer (cancelled on
	 * retarget so a newer switch can take over mid-fade). */
	private layerAnims = perArea<[Animation | null, Animation | null]>(() => [null, null]);
	/** A switch is in flight per area (preload + crossfade). */
	private switching = perArea<boolean>(() => false);
	/** User-requested target index while a switch is in flight. */
	private pendingTarget = perArea<number | undefined>(() => undefined);
	/** Next image already prewarmed (half-interval lookahead). */
	private prewarmed = perArea<boolean>(() => false);

	constructor(ctx: BackgroundCtx) {
		this.ctx = ctx;
		this.state = restoreState();
		this.snapshot = Object.freeze(this.buildSnapshot());
		ctx.effect(() => {
			for (const area of AREAS) {
				this.ensureLayer(area, 0);
				this.ensureLayer(area, 1);
			}
			this.applyDom();
			/* The plugin boots before the shell settles: #root still holds the
			 * loading screen, so column layers land on the wrong host. Watch the
			 * body, but ONLY re-anchor + re-paint when a layer is actually
			 * missing or on the wrong host — a full re-paint on every DOM churn
			 * would race the async file-media paints below. */
			let scheduled = false;
			const reapply = () => {
				if (scheduled) return;
				scheduled = true;
				requestAnimationFrame(() => {
					scheduled = false;
					let needsRepaint = false;
					for (const area of AREAS) {
						const host = this.areaHost(area);
						if (host !== null && !this.layersPlaced(area, host)) {
							needsRepaint = true;
							break;
						}
						for (const which of [0, 1] as const) {
							const el = document.getElementById(this.layerId(area, which));
							if (el === null || host === null || el.parentNode !== host) {
								needsRepaint = true;
								break;
							}
							if (area === "sidebar") {
								// Sidebar layers lead the column in fixed order
								// (a, then b, then content) — see ensureLayer.
								const lead = which === 0 ? null : document.getElementById(this.layerId(area, 0));
								if (el.previousElementSibling !== (lead ?? null)) {
									needsRepaint = true;
									break;
								}
							}
						}
					}
					if (needsRepaint) this.applyDom();
				});
			};
			const observer = new MutationObserver(reapply);
			observer.observe(document.body, { childList: true, subtree: true });
			const timer = setInterval(() => this.tick(), TICK_MS);
			return () => {
				clearInterval(timer);
				observer.disconnect();
				for (const area of AREAS) {
					this.cancelLayerFade(area, 0);
					this.cancelLayerFade(area, 1);
					this.removeLayer(area, 0);
					this.removeLayer(area, 1);
					if (this.fadeTimers[area] !== undefined) clearTimeout(this.fadeTimers[area]);
				}
				for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
				this.objectUrls.clear();
				this.resetDom();
			};
		}, "background: DOM layers + slideshow timer");
	}

	/** Read the current immutable background snapshot. */
	getState(): BackgroundSnapshot {
		return this.snapshot;
	}

	/** Append image configs to an area (non-empty additions enable it). A
	 * group holds ONE media kind: images switch like a slideshow, videos
	 * play — mixing the two is not supported. Mixed batches are filtered to
	 * the group's kind (an empty area adopts the batch's kind, preferring
	 * images when the batch itself is mixed) and the skipped count is
	 * reported to the editor. */
	addImages(area: AreaId, images: ImageConfig[]): AddImagesResult {
		const cfg = this.state.areas[area];
		const valid = images.filter((img) =>
			(img.source === "url" && img.url !== "") || (img.source === "file" && img.fileId !== "")
		);
		if (valid.length === 0) return { added: 0, skipped: 0 };
		const existingKind = cfg.images.length > 0 ? cfg.images[0].media : undefined;
		const groupKind: MediaType = existingKind !== undefined
			? existingKind
			: (valid.some((img) => img.media === "image") ? "image" : "video");
		const accepted = valid.filter((img) => img.media === groupKind);
		const skipped = valid.length - accepted.length;
		if (accepted.length > 0) {
			cfg.images.push(...accepted.map((img) => ({ ...img })));
			cfg.enabled = true;
			this.publish();
		}
		return {
			added: accepted.length,
			skipped,
			skippedKind: skipped > 0 ? (groupKind === "image" ? "video" : "image") : undefined
		};
	}

	/** Remove one image from an area (also drops its stored blob, if local). */
	removeImage(area: AreaId, index: number): void {
		const cfg = this.state.areas[area];
		if (index < 0 || index >= cfg.images.length) return;
		const [removed] = cfg.images.splice(index, 1);
		if (removed.source === "file") {
			deleteStoredFile(removed.fileId);
			this.revokeFileUrl(removed.fileId);
		}
		if (this.index[area] >= cfg.images.length) this.index[area] = cfg.images.length === 0 ? 0 : cfg.images.length - 1;
		if (cfg.images.length === 0) cfg.enabled = false;
		this.publish();
	}

	/** Patch one image's configuration (immutable update). */
	updateImage(area: AreaId, index: number, patch: Partial<ImageConfig>): void {
		const cfg = this.state.areas[area];
		if (index < 0 || index >= cfg.images.length) return;
		const img = cfg.images[index];
		const next: ImageConfig = { ...img, ...patch };
		next.scale = clamp(Number(next.scale) || 100, 10, 500);
		next.rotate = clamp(Number(next.rotate) || 0, -180, 180);
		next.radius = clamp(Number(next.radius) || 0, 0, 200);
		next.opacity = clamp(Number(next.opacity) || 0, 0, 1);
		next.blur = clamp(Number(next.blur) || 0, 0, 24);
		if (typeof next.posX !== "string") next.posX = img.posX;
		if (typeof next.posY !== "string") next.posY = img.posY;
		if (typeof next.width !== "string") next.width = img.width;
		if (typeof next.height !== "string") next.height = img.height;
		if (typeof next.name !== "string") next.name = img.name;
		if (next.media !== "image" && next.media !== "video") next.media = img.media;
		cfg.images[index] = next;
		this.publish();
	}

	/** Toggle an area's background on/off. */
	setEnabled(area: AreaId, enabled: boolean): void {
		const cfg = this.state.areas[area];
		if (cfg.enabled === enabled) return;
		cfg.enabled = enabled;
		this.elapsed[area] = 0;
		this.publish();
	}

	/** Set the slideshow interval in seconds (0 stops playback). */
	setIntervalSec(area: AreaId, seconds: number): void {
		const cfg = this.state.areas[area];
		const next = clamp(Number(seconds) || 0, 0, 3600);
		if (cfg.intervalSec === next) return;
		cfg.intervalSec = next;
		this.elapsed[area] = 0;
		this.publish();
	}

	/** Toggle order vs random playback. */
	setRandom(area: AreaId, random: boolean): void {
		const cfg = this.state.areas[area];
		if (cfg.random === random) return;
		cfg.random = random;
		this.elapsed[area] = 0;
		this.publish();
	}

	/** Manually step to the next image. A single-image area has no "next" —
	 * nothing switches, no fade fires (the UI disables the button too). */
	next(area: AreaId): void {
		const cfg = this.state.areas[area];
		if (cfg.images.length < 2) return;
		this.requestSwitch(area);
	}

	/** Show a specific image (selecting a strip thumbnail previews it). */
	showImage(area: AreaId, index: number): void {
		const cfg = this.state.areas[area];
		if (index < 0 || index >= cfg.images.length) return;
		this.requestSwitch(area, index);
	}

	/** Resolve an image's display URL. File images load lazily from IndexedDB
	 * into a cached object URL. */
	async displayUrlOf(img: ImageConfig): Promise<string> {
		if (img.source === "url") return img.url;
		const cached = this.objectUrls.get(img.fileId);
		if (cached !== undefined) return cached;
		try {
			const blob = await idbGetFile(img.fileId);
			if (blob === null) return "";
			const url = URL.createObjectURL(blob);
			this.objectUrls.set(img.fileId, url);
			return url;
		} catch {
			return "";
		}
	}

	/** Revoke (and forget) a local image's object URL. */
	revokeFileUrl(fileId: string): void {
		const url = this.objectUrls.get(fileId);
		if (url !== undefined) {
			URL.revokeObjectURL(url);
			this.objectUrls.delete(fileId);
		}
	}

	//#region playback + preloaded switching

	/** Preload a media's bytes AND ready state (so switching never shows a
	 * gap): images decode through an Image element, videos reach canplay
	 * through a detached muted video element. */
	private preload(img: ImageConfig): Promise<boolean> {
		return this.displayUrlOf(img).then((url) => {
			if (url === "") return false;
			const existing = this.preloadCache.get(url);
			if (existing !== undefined) return existing;
			const promise = new Promise<boolean>((resolve) => {
				if (img.media === "video") {
					const video = document.createElement("video");
					video.muted = true;
					video.preload = "auto";
					video.addEventListener("canplay", () => resolve(true), { once: true });
					video.addEventListener("error", () => resolve(false), { once: true });
					video.src = url;
				} else {
					const image = new Image();
					image.onload = () => resolve(true);
					image.onerror = () => resolve(false);
					image.src = url;
				}
			});
			this.preloadCache.set(url, promise);
			return promise;
		});
	}

	/** Prewarm the next image half an interval early (bytes + ready cache). */
	private prewarm(area: AreaId): void {
		const cfg = this.state.areas[area];
		if (!cfg.enabled || cfg.images.length < 2) return;
		const nextIndex = this.nextIndex(area, cfg.images.length);
		void this.preload(cfg.images[nextIndex]);
	}

	/** Compute the next playback index (order or random). */
	private nextIndex(area: AreaId, count: number): number {
		const cfg = this.state.areas[area];
		if (count < 2) return 0;
		if (cfg.random) {
			let pick: number;
			do {
				pick = Math.floor(Math.random() * count);
			} while (pick === this.index[area] && count > 1);
			return pick;
		}
		return (this.index[area] + 1) % count;
	}

	/** Queue a switch (to a specific image, or the next one). */
	private requestSwitch(area: AreaId, targetIndex?: number): void {
		this.pendingTarget[area] = targetIndex ?? this.pendingTarget[area];
		if (!this.switching[area]) void this.performSwitch(area);
	}

	/** Preload the target media, then commit the index (crossfade lands via
	 * publish → applyArea). Waits for the load even past the scheduled time;
	 * a failed load keeps the current image until the next attempt. */
	private async performSwitch(area: AreaId): Promise<void> {
		if (this.switching[area]) return;
		this.switching[area] = true;
		try {
			while (true) {
				const target = this.pendingTarget[area];
				this.pendingTarget[area] = undefined;
				const cfg = this.state.areas[area];
				if (!cfg.enabled || cfg.images.length === 0) break;
				const nextIndex = target !== undefined ? target : this.nextIndex(area, cfg.images.length);
				if (nextIndex === this.index[area] && target === undefined) break;
				const ok = await this.preload(cfg.images[nextIndex]);
				if (!ok) break; // media unavailable: stay on the current one
				if (this.index[area] !== nextIndex) {
					this.index[area] = nextIndex;
					this.elapsed[area] = 0;
					this.prewarmed[area] = false;
					this.publish(); // → applyDom → applyArea → crossfade
				}
				if (this.pendingTarget[area] === undefined) break;
			}
		} finally {
			this.switching[area] = false;
		}
	}

	/** Slideshow heartbeat: prewarm at half interval, switch at the interval
	 * (the switch itself waits for the preload — the interval may overrun). */
	private tick(): void {
		for (const area of AREAS) {
			const cfg = this.state.areas[area];
			if (!cfg.enabled || cfg.images.length < 2 || cfg.intervalSec <= 0) continue;
			this.elapsed[area] += TICK_MS;
			if (this.elapsed[area] >= cfg.intervalSec * 500 && !this.prewarmed[area]) {
				this.prewarmed[area] = true;
				this.prewarm(area);
			}
			if (this.elapsed[area] >= cfg.intervalSec * 1000) {
				this.elapsed[area] = 0;
				this.prewarmed[area] = false;
				this.requestSwitch(area);
			}
		}
	}

	/** Current image config for an area (undefined when off or unset). */
	currentImage(area: AreaId): ImageConfig | undefined {
		const cfg = this.state.areas[area];
		if (!cfg.enabled || cfg.images.length === 0) return undefined;
		return cfg.images[this.index[area] % cfg.images.length];
	}

	//#endregion

	//#region publish / snapshot

	private publish(): void {
		this.revision += 1;
		if (!persistState(this.state)) this.lastError = "quota";
		else this.lastError = null;
		this.snapshot = Object.freeze(this.buildSnapshot());
		this.applyDom();
		this.ctx.emit("background/change", this.snapshot);
	}

	/** Immutable snapshot: per-area config + playback index. Images are
	 * deep-copied — the settings store's immer updates freeze whatever they
	 * receive, which must never be the live service state. */
	private buildSnapshot(): BackgroundSnapshot {
		const areas = {} as BackgroundSnapshot["areas"];
		for (const area of AREAS) {
			areas[area] = {
				...this.state.areas[area],
				images: this.state.areas[area].images.map((img) => ({ ...img }))
			};
		}
		return {
			areas,
			index: { ...this.index },
			lastError: this.lastError,
			revision: this.revision
		};
	}

	//#endregion

	//#region DOM projection (layer pairs + crossfade)

	private layerId(area: AreaId, which: LayerIndex): string {
		return `dsh-bg-layer-${area}-${which === 0 ? "a" : "b"}`;
	}

	/** Whether the host's children satisfy the area's placement invariant:
 * sidebar layers lead the column; every other area's layers trail it. */
	private layersPlaced(area: AreaId, host: HTMLElement): boolean {
		let sawLayer = false;
		let sawContent = false;
		for (const child of Array.from(host.children)) {
			const isLayer = (child as HTMLElement).id?.startsWith("dsh-bg-layer") ?? false;
			if (isLayer) sawLayer = true;
			else sawContent = true;
			// lead: a layer after content is wrong; trail: content after a layer is wrong
			if (isLayer ? area === "sidebar" && sawContent : area !== "sidebar" && sawLayer) return false;
		}
		return true;
	}

	/** The DOM host each area's layers mount into. */
	private areaHost(area: AreaId): HTMLElement | null {
		switch (area) {
			case "sidebar": {
				// The column is the settings trigger's ancestor whose parent
				// holds the conversation surface. Slot outlets are wrapped in
				// display:contents divs, so structural selectors are off by
				// one — the climb works at any wrapper depth.
				const trigger = document.querySelector('button[aria-haspopup="dialog"]');
				const scroll = document.querySelector("[data-conversation-scroll]");
				let node = trigger?.parentElement ?? null;
				while (node instanceof HTMLElement && node !== document.body) {
					const parent = node.parentElement;
					if (parent instanceof HTMLElement && scroll !== null && parent.contains(scroll)) return node;
					node = parent;
				}
				return null;
			}
			case "conversation":
				// [data-conversation-scroll] is a direct child of the surface
				// root; mount the layers on that root so the background stays
				// fixed while the messages scroll.
				return document.querySelector("[data-conversation-scroll]")?.parentElement ?? null;
			case "trajectory":
				return document.querySelector("[data-conversation-composer-overlay]");
			case "settings":
				return document.querySelector('[role="dialog"][aria-modal="true"]');
			default:
				return null;
		}
	}

	/** Create (or re-anchor) one layer element for an area. Layers sit at
	 * the END of their host; the sidebar is the exception — its layers LEAD
	 * the column (a, then b, then content) so tree order alone (content
	 * position:relative, z auto) keeps content above the wallpaper without
	 * a z-index that would trap the settings dialog inside the wrapper. */
	private ensureLayer(area: AreaId, which: LayerIndex): HTMLElement {
		const id = this.layerId(area, which);
		const host = this.areaHost(area);
		let el = document.getElementById(id) as HTMLElement | null;
		if (el === null) {
			el = document.createElement("div");
			el.id = id;
			el.setAttribute("aria-hidden", "true");
		}
		if (host !== null) {
			if (area === "sidebar") {
				const lead = which === 0 ? null : document.getElementById(this.layerId(area, 0));
				if (el.parentNode !== host || el.previousElementSibling !== (lead ?? null)) {
					const oldParent = el.parentNode;
					if (oldParent instanceof HTMLElement && oldParent !== host) oldParent.removeAttribute("data-dshbg-sidebar-host");
					host.insertBefore(el, lead !== null ? lead.nextSibling : host.firstChild);
				}
				// CSS matches the host via this marker (structural selectors are
				// off by one behind the shell's slot wrappers).
				host.setAttribute("data-dshbg-sidebar-host", "");
			} else if (el.parentNode !== host) {
				host.appendChild(el);
			} else if (host.lastElementChild !== el) {
				host.appendChild(el);
			}
		}
		return el;
	}

	private removeLayer(area: AreaId, which: LayerIndex): void {
		document.getElementById(this.layerId(area, which))?.remove();
	}

	private resetDom(): void {
		const root = document.documentElement;
		for (const area of AREAS) {
			root.removeAttribute(`data-dsh-bg-${area}`);
		}
		for (const host of Array.from(document.querySelectorAll("[data-dshbg-sidebar-host]"))) {
			host.removeAttribute("data-dshbg-sidebar-host");
		}
	}

	/** Project all areas onto the DOM (async crossfade paints). */
	applyDom(): void {
		for (const area of AREAS) {
			this.ensureLayer(area, 0);
			this.ensureLayer(area, 1);
			void this.applyArea(area);
		}
	}

	/** Two configs denote the same media (no switch, no fade between them). */
	private sameMedia(a: ImageConfig | undefined | null, b: ImageConfig | undefined): boolean {
		if (a === undefined || a === null || b === undefined) return false;
		return a.url === b.url && a.fileId === b.fileId && a.media === b.media;
	}

	/** One area's projection: when the target media changed, crossfade to it
	 * (incoming layer fades in while the outgoing one fades out); when it is
	 * the same media (single-image areas, per-image render tweaks), repaint
	 * in place without any fade. */
	private async applyArea(area: AreaId): Promise<void> {
		const target = this.currentImage(area);
		if (this.sameMedia(this.lastPainted[area], target)) {
			this.lastPainted[area] = target !== undefined ? { ...target } : null;
			if (this.fadeTimers[area] !== undefined) {
				// A crossfade to this very media is in flight. If the layer
				// pair survived, the fade already delivers it — repainting the
				// outgoing layer here would clobber the fade with an instant
				// full-opacity paint. If the layers were re-created meanwhile
				// (session/view switch destroyed the host), the fade cannot
				// settle on the new elements: cancel it and restore directly.
				if (this.layerPairHealthy(area)) return;
				clearTimeout(this.fadeTimers[area]);
				this.fadeTimers[area] = undefined;
			}
			this.refreshActiveLayer(area);
			return;
		}
		// URL media resolve synchronously (gate + paint land immediately);
		// file media resolve from IndexedDB asynchronously.
		const url = target !== undefined && target.source === "url"
			? target.url
			: (target !== undefined ? await this.displayUrlOf(target) : "");
		if (this.currentImage(area) !== target) return; // target changed meanwhile
		this.lastPainted[area] = target !== undefined ? { ...target } : null;
		const root = document.documentElement;
		root.setAttribute(`data-dsh-bg-${area}`, url !== "" ? "on" : "off");
		const prev = this.activeLayer[area];
		const next: LayerIndex = prev === 0 ? 1 : 0;
		if (!this.paintedOnce[area]) {
			// First paint: show directly, no animation.
			this.paintLayer(area, next, url, target, 1);
			this.setLayerFade(area, prev, 0);
			this.activeLayer[area] = next;
			this.paintedOnce[area] = true;
			return;
		}
		// Crossfade: stage the incoming layer's media at fade 0, then fade it
		// in while the outgoing layer fades out (keeping its media until
		// settled). The fade is driven by the Web Animations API rather than
		// a CSS transition: it starts deterministically (no forced-reflow
		// dance), survives shell stylesheet overrides and reduced-motion
		// resets, and retargets cleanly when a newer switch lands mid-fade.
		const incomingFrom = this.currentLayerOpacity(area, next); // read before staging (retarget continuity)
		this.paintLayer(area, next, url, target, 0);
		this.fadeLayer(area, next, target !== undefined ? clamp(target.opacity, 0, 1) : 0, incomingFrom);
		this.fadeLayer(area, prev, 0);
		if (this.fadeTimers[area] !== undefined) clearTimeout(this.fadeTimers[area]);
		this.fadeTimers[area] = setTimeout(() => {
			this.fadeTimers[area] = undefined;
			if (!this.layerPairHealthy(area)) {
				// The layer pair was re-created while the fade ran: the fade
				// cannot settle on the new elements. Repaint the active layer
				// directly (the playback index already advanced, so the
				// current image is exactly the fade target).
				this.refreshActiveLayer(area);
				return;
			}
			this.activeLayer[area] = next;
			this.cleanupLayer(area, prev);
			this.ensureActiveFade(area);
		}, FADE_SETTLE_MS);
	}

	/** True when both layer elements exist and have been projected at least
	 * once. A fresh element (re-created after its host was destroyed) has
	 * not been painted or explicitly hidden yet, so it must be initialized
	 * before the pair can be trusted. */
	private layerPairHealthy(area: AreaId): boolean {
		for (const which of [0, 1] as const) {
			const el = document.getElementById(this.layerId(area, which));
			if (el === null || !this.projectedLayers.has(el)) return false;
		}
		return true;
	}

	/** Identity key of a media config. Configs are replaced immutably on
	 * every tweak, so object identity cannot tell whether the media changed
	 * while an async paint was in flight. */
	private mediaKeyOf(img: ImageConfig | undefined): string {
		return img !== undefined ? `${img.media}\u0000${img.url}\u0000${img.fileId}` : "";
	}

	/** Cancel a layer's running fade animation (if any). */
	private cancelLayerFade(area: AreaId, which: LayerIndex): void {
		const anim = this.layerAnims[area][which];
		if (anim !== null) {
			anim.cancel();
			this.layerAnims[area][which] = null;
		}
	}

	/** Keep a layer's muted video in step with its visibility: visible
	 * layers play, hidden ones pause (no decoding cost while hidden). */
	private syncVideoPlayState(el: HTMLElement, visible: boolean): void {
		const media = el.firstElementChild;
		if (media === null || media.tagName !== "VIDEO") return;
		const video = media as HTMLVideoElement;
		if (visible) {
			void video.play().catch(() => {
				// Autoplay refused (should not happen: muted + playsinline) —
				// the frame still renders; a later repaint retries play.
			});
		} else {
			video.pause();
		}
	}

	/** A layer's current VISUAL opacity: computed style reflects a running
	 * animation's interpolated value (inline style does not). */
	private currentLayerOpacity(area: AreaId, which: LayerIndex): number {
		const el = document.getElementById(this.layerId(area, which));
		if (el === null) return 0;
		const raw = Number(getComputedStyle(el).opacity);
		return Number.isFinite(raw) ? clamp(raw, 0, 1) : 0;
	}

	/** Drive one layer's opacity to `to` with a WAAPI animation. The start
	 * value is the layer's current visual opacity (or an explicit `from`
	 * pinned by the caller before re-staging) so a retarget mid-fade
	 * continues exactly where the previous animation left off; on finish
	 * the inline opacity is pinned to the target and the animation dropped. */
	private fadeLayer(area: AreaId, which: LayerIndex, to: number, from?: number): void {
		const el = document.getElementById(this.layerId(area, which));
		if (el === null) return;
		this.projectedLayers.add(el);
		const raw = from !== undefined ? from : Number(getComputedStyle(el).opacity);
		this.cancelLayerFade(area, which);
		const target = clamp(to, 0, 1);
		const start = Number.isFinite(raw) ? clamp(raw, 0, 1) : 0;
		if (start === target || typeof el.animate !== "function") {
			// No movement needed, or the Web Animations API is unavailable
			// (ancient engine): pin the inline value directly.
			el.style.opacity = String(target);
			this.syncVideoPlayState(el, target > 0);
			return;
		}
		const anim = el.animate(
			[{ opacity: String(start) }, { opacity: String(target) }],
			{ duration: FADE_MS, easing: "ease", fill: "forwards" }
		);
		this.layerAnims[area][which] = anim;
		anim.onfinish = () => {
			el.style.opacity = String(target);
			anim.cancel(); // drop the forwards fill — inline now holds the value
			if (this.layerAnims[area][which] === anim) this.layerAnims[area][which] = null;
			this.syncVideoPlayState(el, target > 0);
		};
		// Visible layers play immediately (hidden ones pause at the finish).
		this.syncVideoPlayState(el, target > 0);
	}

	/** Refresh the currently visible layer's media/render in place (same
	 * media — opacity/blur tweaks, no animation) and keep the OTHER layer
	 * hidden: after a session/view switch re-creates the layer pair, the
	 * fresh sibling must be pinned to fade 0 or it covers the active layer. */
	private refreshActiveLayer(area: AreaId): void {
		const active = this.activeLayer[area];
		const img = this.currentImage(area);
		const mediaKey = this.mediaKeyOf(img);
		this.setLayerFade(area, active === 0 ? 1 : 0, 0);
		void this.displayUrlOf(img ?? ({ source: "url", url: "", media: "image" } as ImageConfig)).then((url) => {
			const current = this.currentImage(area);
			// A crossfade started meanwhile (it owns the layer pair), or the
			// media changed (a newer applyArea owns the paint) — stand down.
			if (this.fadeTimers[area] !== undefined || this.mediaKeyOf(current) !== mediaKey) return;
			this.paintLayer(area, active, url, current, 1);
		});
	}

	/** Paint one layer: render vars + fade, and the media child (an image
	 * div or a muted looping video). Videos pause at fade 0. */
	private paintLayer(area: AreaId, which: LayerIndex, url: string, img: ImageConfig | undefined, fade: number): void {
		const el = document.getElementById(this.layerId(area, which));
		if (el === null) return;
		this.projectedLayers.add(el);
		this.cancelLayerFade(area, which); // direct write supersedes any running fade
		const opacity = img !== undefined ? clamp(img.opacity, 0, 1) : 0;
		const display = img !== undefined ? resolveDisplay(img) : { size: "cover", position: "center", repeat: "no-repeat", rotate: "0deg", radius: "0px" };
		el.style.opacity = String(clamp(fade, 0, 1) * opacity);
		el.style.filter = `blur(${img !== undefined ? clamp(Math.round(img.blur * 10) / 10, 0, 24) : 0}px)`;
		el.style.transform = `rotate(${display.rotate})`;
		el.style.borderRadius = display.radius;

		// Media child: ensure the element kind matches the media type.
		const isVideo = img !== undefined && img.media === "video";
		let media = el.firstElementChild as HTMLElement | null;
		if (media !== null && media.tagName !== (isVideo ? "VIDEO" : "DIV")) {
			media.remove();
			media = null;
		}
		if (media === null) {
			media = document.createElement(isVideo ? "video" : "div");
			media.className = "dshbg-media";
			if (isVideo) {
				const video = media as HTMLVideoElement;
				video.setAttribute("muted", "");
				video.setAttribute("loop", "");
				video.setAttribute("playsinline", "");
				video.setAttribute("preload", "auto");
				video.volume = 0; // belt and braces: never any sound
			}
			el.appendChild(media);
		}

		if (img === undefined || url === "") {
			if (media.tagName === "VIDEO") {
				const video = media as HTMLVideoElement;
				video.pause();
				video.removeAttribute("src");
			} else {
				(media as HTMLElement).style.backgroundImage = "none";
			}
			return;
		}

		if (media.tagName === "VIDEO") {
			const video = media as HTMLVideoElement;
			if (video.getAttribute("src") !== url) video.src = url;
			video.style.objectFit = videoFitOf(img.mode);
			video.style.objectPosition = `${img.posX} ${img.posY}`;
			if (fade > 0) {
				void video.play().catch(() => {
					// Autoplay refused (should not happen: muted + playsinline) —
					// the frame still renders; a later repaint retries play.
				});
			} else {
				video.pause();
			}
		} else {
			const div = media as HTMLElement;
			div.style.backgroundImage = `url("${escapeCssString(url)}")`;
			div.style.backgroundSize = display.size;
			div.style.backgroundPosition = display.position;
			div.style.backgroundRepeat = display.repeat;
		}
	}

	private setLayerFade(area: AreaId, which: LayerIndex, fade: number): void {
		const el = document.getElementById(this.layerId(area, which));
		if (el === null) return;
		this.projectedLayers.add(el);
		this.cancelLayerFade(area, which); // direct write supersedes any running fade
		const img = this.currentImage(area);
		const opacity = img !== undefined ? clamp(img.opacity, 0, 1) : 0;
		el.style.opacity = String(clamp(fade, 0, 1) * opacity);
		// Keep the video playing state in step with its fade.
		this.syncVideoPlayState(el, fade > 0);
	}

	/** Drop a layer's media (after its fade-out completed). */
	private cleanupLayer(area: AreaId, which: LayerIndex): void {
		const el = document.getElementById(this.layerId(area, which));
		if (el === null) return;
		this.cancelLayerFade(area, which);
		el.style.opacity = "0";
		const media = el.firstElementChild;
		if (media !== null) {
			if (media.tagName === "VIDEO") {
				const video = media as HTMLVideoElement;
				video.pause();
				video.removeAttribute("src");
			} else {
				(media as HTMLElement).style.backgroundImage = "none";
			}
		}
	}

	/** Ensure the active layer is fully visible and the other is hidden. */
	private ensureActiveFade(area: AreaId): void {
		const active = this.activeLayer[area];
		this.setLayerFade(area, active, 1);
		this.setLayerFade(area, active === 0 ? 1 : 0, 0);
	}

	//#endregion
}
