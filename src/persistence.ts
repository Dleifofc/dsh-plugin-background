/**
 * src/persistence.ts — config persistence (localStorage, small JSON only) and
 * local media storage (IndexedDB Blobs — files are never base64-packed).
 */
import {
	AREAS, DEFAULT_AREA, DEFAULT_IMAGE, IDB_NAME, IDB_STORE, MODES, REPEATS, STORAGE_KEY, clamp,
	defaultState, mediaOfName
} from "./constants";
import type { AreaConfig, AreaId, BackgroundState, ImageConfig } from "./types";

//#region config persistence (localStorage)

/** Build a fresh (default) state object. Each area owns its media array. */
export function freshState(): BackgroundState {
	return defaultState();
}

/** Narrow an unknown parsed value to an ImageConfig, or null. */
function parseImage(value: unknown): ImageConfig | null {
	if (value === null || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const img: ImageConfig = { ...DEFAULT_IMAGE };
	if (raw.source === "file") {
		if (typeof raw.fileId !== "string" || raw.fileId === "") return null;
		img.source = "file";
		img.fileId = raw.fileId;
		img.name = typeof raw.name === "string" ? raw.name : "";
		img.media = typeof raw.media === "string" && raw.media === "video" ? "video" : mediaOfName(img.name);
	} else {
		if (typeof raw.url !== "string" || raw.url === "") return null;
		img.source = "url";
		img.url = raw.url;
		img.media = typeof raw.media === "string" && raw.media === "video" ? "video" : mediaOfName(raw.url);
	}
	if (typeof raw.mode === "string" && (MODES as readonly string[]).includes(raw.mode)) img.mode = raw.mode as ImageConfig["mode"];
	if (typeof raw.posX === "string") img.posX = raw.posX;
	if (typeof raw.posY === "string") img.posY = raw.posY;
	if (typeof raw.scale === "number" && Number.isFinite(raw.scale)) img.scale = clamp(raw.scale, 10, 500);
	if (typeof raw.width === "string") img.width = raw.width;
	if (typeof raw.height === "string") img.height = raw.height;
	if (typeof raw.repeat === "string" && (REPEATS as readonly string[]).includes(raw.repeat)) img.repeat = raw.repeat as ImageConfig["repeat"];
	if (typeof raw.rotate === "number" && Number.isFinite(raw.rotate)) img.rotate = clamp(raw.rotate, -180, 180);
	if (typeof raw.radius === "number" && Number.isFinite(raw.radius)) img.radius = clamp(raw.radius, 0, 200);
	if (typeof raw.opacity === "number" && Number.isFinite(raw.opacity)) img.opacity = clamp(raw.opacity, 0, 1);
	if (typeof raw.blur === "number" && Number.isFinite(raw.blur)) img.blur = clamp(raw.blur, 0, 24);
	return img;
}

/** Legacy area ids: old layouts stored the page backdrop under "center"
 * (the old whole-page layer). Both map onto the conversation surface —
 * the closest surviving area (the page backdrop itself was removed). */
const LEGACY_AREA_MAP: Record<string, AreaId | undefined> = {
	center: "conversation",
	sidebar: "sidebar"
};

/** Read the persisted state; unknown or unreadable values fall back to defaults. */
export function restoreState(): BackgroundState {
	if (typeof localStorage === "undefined") return freshState();
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === null) return freshState();
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return freshState();
		const areas = (parsed as Record<string, unknown>).areas;
		if (areas === null || typeof areas !== "object") return freshState();
		const state = freshState();
		for (const storedKey of Object.keys(areas as Record<string, unknown>)) {
			const area = LEGACY_AREA_MAP[storedKey] ?? (AREAS.includes(storedKey as AreaId) ? (storedKey as AreaId) : undefined);
			if (area === undefined) continue;
			const stored = (areas as Record<string, unknown>)[storedKey];
			if (stored === null || typeof stored !== "object") continue;
			const cfg: AreaConfig = state.areas[area];
			const rec = stored as Record<string, unknown>;
			if (typeof rec.enabled === "boolean") cfg.enabled = rec.enabled;
			if (Array.isArray(rec.images)) {
				const parsed = rec.images.map(parseImage).filter((img): img is ImageConfig => img !== null);
				// Groups are single-kind (images OR videos, never mixed):
				// configs saved by older builds could hold a mix, so keep the
				// first image's kind and drop the rest.
				const kind = parsed.length > 0 ? parsed[0].media : undefined;
				cfg.images = kind !== undefined ? parsed.filter((img) => img.media === kind) : [];
			}
			if (typeof rec.intervalSec === "number" && Number.isFinite(rec.intervalSec)) cfg.intervalSec = clamp(rec.intervalSec, 0, 3600);
			if (typeof rec.random === "boolean") cfg.random = rec.random;
		}
		return state;
	} catch {
		return freshState();
	}
}

/** Persist the config; returns false on storage failure. */
export function persistState(state: BackgroundState): boolean {
	if (typeof localStorage === "undefined") return true;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
		return true;
	} catch {
		return false;
	}
}

//#endregion

//#region IndexedDB media blobs

/** Open the IndexedDB database (creates the file store on first use). */
function idbOpen(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(IDB_NAME, 1);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** A stored local file: its raw bytes plus the original MIME type. */
export interface StoredImage {
	buffer: ArrayBuffer;
	type: string;
}

/** Store a file's raw bytes (ArrayBuffer) under a key. Storing the Blob
 * object itself is unreliable — structured-cloning a File can yield a
 * zero-byte blob in some Chromium paths — so the bytes are read explicitly. */
export async function idbPutFile(key: string, data: StoredImage): Promise<void> {
	const db = await idbOpen();
	try {
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, "readwrite");
			tx.objectStore(IDB_STORE).put(data, key);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	} finally {
		db.close();
	}
}

/** Read a stored file back as a Blob (null when missing). */
export async function idbGetFile(key: string): Promise<Blob | null> {
	const db = await idbOpen();
	try {
		return await new Promise<Blob | null>((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, "readonly");
			const request = tx.objectStore(IDB_STORE).get(key);
			request.onsuccess = () => {
				const rec = request.result as StoredImage | undefined;
				resolve(rec !== undefined ? new Blob([rec.buffer], { type: rec.type }) : null);
			};
			request.onerror = () => reject(request.error);
		});
	} finally {
		db.close();
	}
}

/** Delete a stored Blob by key. */
export async function idbDeleteFile(key: string): Promise<void> {
	const db = await idbOpen();
	try {
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, "readwrite");
			tx.objectStore(IDB_STORE).delete(key);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	} finally {
		db.close();
	}
}

//#endregion
