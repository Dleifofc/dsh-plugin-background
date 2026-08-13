/**
 * src/display.ts — resolve a per-image config into CSS values.
 */
import { clamp } from "./constants";
import type { DisplayMode, DisplayValues, ImageConfig } from "./types";

/**
 * Resolve an image's display settings into CSS values. Quick modes map to
 * standard background combinations; custom mode uses the detailed fields
 * (position, scale, width/height, repeat). Rotation and radius always apply
 * as layer transform / border-radius.
 */
export function resolveDisplay(img: ImageConfig): DisplayValues {
	let size = "cover";
	let position = "center";
	let repeat = "no-repeat";
	if (img.mode === "contain") {
		size = "contain";
	} else if (img.mode === "fill") {
		size = "100% 100%";
	} else if (img.mode === "repeat") {
		size = "auto";
		position = "0% 0%";
		repeat = "repeat";
	} else if (img.mode === "center") {
		size = "auto";
	} else if (img.mode === "custom") {
		size = img.width !== "" || img.height !== ""
			? `${img.width !== "" ? img.width : "auto"} ${img.height !== "" ? img.height : "auto"}`
			: (img.scale !== 100 ? `${img.scale}% ${img.scale}%` : "auto");
		position = `${img.posX} ${img.posY}`;
		repeat = img.repeat;
	}
	return {
		size,
		position,
		repeat,
		rotate: `${clamp(Math.round(img.rotate * 10) / 10, -180, 180)}deg`,
		radius: `${clamp(Math.round(img.radius), 0, 200)}px`
	};
}

/**
 * Resolve a video's object-fit from the display mode. Videos cannot tile, so
 * repeat maps to contain; cover/fill/contain map directly; center and custom
 * use contain with the configured position.
 */
export function videoFitOf(mode: DisplayMode): string {
	if (mode === "fill") return "fill";
	if (mode === "contain" || mode === "repeat" || mode === "center" || mode === "custom") return "contain";
	return "cover";
}
