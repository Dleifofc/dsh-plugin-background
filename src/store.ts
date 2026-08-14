/**
 * src/store.ts — settings store mirror of the background service snapshot.
 * The plugin's change listener is the only writer; the section reads it via
 * the composed useStore prop.
 */
import { defineStore } from "@deepseek-ai/dsh-client-runtime/client";
import { DEFAULT_STATE } from "./constants";
import { freshState } from "./persistence";
import type { AreaConfig, BackgroundSnapshot, SurfaceId, SurfaceMeta } from "./types";

export interface BackgroundRowState {
	areas: Record<SurfaceId, AreaConfig & { index: number }>;
	meta: Record<SurfaceId, SurfaceMeta>;
	lastError: string | null;
	revision: number;
}

export function createBackgroundStore() {
	return defineStore({
		init: (): BackgroundRowState => {
			const state = freshState();
			const areas = {} as BackgroundRowState["areas"];
			const meta = {} as BackgroundRowState["meta"];
			for (const [surface, cfg] of Object.entries(state.areas)) {
				areas[surface] = { ...cfg, index: 0 };
				meta[surface] = { label: surface, group: "builtin", available: true };
			}
			return {
				areas,
				meta,
				lastError: null,
				revision: -1
			};
		},
		actions: {
			sync: (draft, state: BackgroundSnapshot, revision: number) => {
				if (revision <= draft.revision) return;
				// Replace the whole surface set (tabs come and go): drop
				// surfaces the service no longer reports, add the new ones.
				for (const surface of Object.keys(draft.areas)) {
					if (state.areas[surface] === undefined) delete draft.areas[surface];
				}
				for (const surface of Object.keys(state.areas)) {
					const cfg = draft.areas[surface] ?? { enabled: false, images: [], intervalSec: 15, random: false, index: 0 };
					cfg.enabled = state.areas[surface].enabled;
					cfg.images = state.areas[surface].images;
					cfg.intervalSec = state.areas[surface].intervalSec;
					cfg.random = state.areas[surface].random;
					cfg.index = state.index[surface] ?? 0;
					draft.areas[surface] = cfg;
				}
				draft.meta = state.meta;
				draft.lastError = state.lastError;
				draft.revision = revision;
			}
		}
	});
}

/** Re-export for the entry face. */
export { DEFAULT_STATE };
