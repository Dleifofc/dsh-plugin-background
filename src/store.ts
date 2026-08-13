/**
 * src/store.ts — settings store mirror of the background service snapshot.
 * The plugin's change listener is the only writer; the section reads it via
 * the composed useStore prop.
 */
import { defineStore } from "@deepseek-ai/dsh-client-runtime/client";
import { AREAS, DEFAULT_STATE } from "./constants";
import { freshState } from "./persistence";
import type { AreaConfig, AreaId, BackgroundSnapshot } from "./types";

export interface BackgroundRowState {
	areas: Record<AreaId, AreaConfig & { index: number }>;
	lastError: string | null;
	revision: number;
}

export function createBackgroundStore() {
	return defineStore({
		init: (): BackgroundRowState => {
			const state = freshState();
			const areas = {} as BackgroundRowState["areas"];
			for (const area of AREAS) areas[area] = { ...state.areas[area], index: 0 };
			return {
				areas,
				lastError: null,
				revision: -1
			};
		},
		actions: {
			sync: (draft, state: BackgroundSnapshot, revision: number) => {
				if (revision <= draft.revision) return;
				for (const area of AREAS) {
					const cfg = draft.areas[area];
					cfg.enabled = state.areas[area].enabled;
					cfg.images = state.areas[area].images;
					cfg.intervalSec = state.areas[area].intervalSec;
					cfg.random = state.areas[area].random;
					cfg.index = state.index[area];
				}
				draft.lastError = state.lastError;
				draft.revision = revision;
			}
		}
	});
}

/** Re-export for the entry face. */
export { DEFAULT_STATE };
