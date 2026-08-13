/**
 * src/ui.ts — the Background settings section (own nav entry in Settings):
 * per-area segmented control, image strip, per-image editor (display mode,
 * detailed parameters, per-image opacity/blur), playback controls, and local
 * file/folder picking.
 */
import { jsx, jsxs, Fragment } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { Button, IconChevronDownOutline14, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import { AREAS, MODES, REPEATS, parseImageList, imageOfUrl } from "./constants";
import { importPickedFiles, pickFiles } from "./files";
import type { AddImagesResult } from "./service";
import type { PickerAccept } from "./files";
import type { AreaId, ImageConfig } from "./types";
import type { BackgroundRowState } from "./store";

/** Composed slot props handed to the section component. */
export interface BackgroundSectionProps {
	t: (key: string) => string;
	useStore: <T>(selector: (state: BackgroundRowState) => T) => T;
	/** Add images/videos to an area. Groups are single-kind: a mixed batch
	 * is filtered and the skipped part reported via the result. */
	addImages: (area: AreaId, images: ImageConfig[]) => AddImagesResult;
	removeImage: (area: AreaId, index: number) => void;
	updateImage: (area: AreaId, index: number, patch: Partial<ImageConfig>) => void;
	setEnabled: (area: AreaId, enabled: boolean) => void;
	setIntervalSec: (area: AreaId, seconds: number) => void;
	setRandom: (area: AreaId, random: boolean) => void;
	next: (area: AreaId) => void;
	/** Show a specific image (selecting a strip thumbnail previews it). */
	showImage: (area: AreaId, index: number) => void;
	/** Resolve a display URL for an image (local files via IndexedDB). */
	resolvePreview: (img: ImageConfig) => Promise<string>;
}

/** One strip thumbnail. Local-file previews resolve asynchronously. */
function StripItem(props: {
	t: (key: string) => string;
	img: ImageConfig;
	index: number;
	selected: boolean;
	onSelect: (index: number) => void;
	onRemove: (index: number) => void;
	resolvePreview: (img: ImageConfig) => Promise<string>;
}) {
	const { t, img, index, selected, onSelect, onRemove, resolvePreview } = props;
	const [preview, setPreview] = useState("");
	useEffect(() => {
		let cancelled = false;
		void resolvePreview(img).then((url) => {
			if (!cancelled && url !== "") setPreview(url);
		});
		return () => {
			cancelled = true;
		};
	}, [img, resolvePreview]);
	const src = img.source === "url" ? img.url : preview;
	return jsx("button", {
		type: "button",
		className: `dshbg-thumb${selected ? " dshbg-selected" : ""}`,
		"aria-pressed": selected,
		onClick: () => onSelect(index),
		children: jsxs(Fragment, {
			children: [
				img.media === "video"
					? jsx("video", {
						className: "dshbg-thumbImg",
						muted: true,
						preload: "metadata",
						playsInline: true,
						src
					})
					: jsx("img", { className: "dshbg-thumbImg", src, alt: "" }),
				jsx("span", { className: "dshbg-thumbName", children: img.source === "file" && img.name !== "" ? img.name : img.url }),
				jsx(Fragment, {
					children: [
						img.source === "file" ? jsx("span", { className: "dshbg-thumbTag", children: t("list.local") }) : null,
						img.media === "video" ? jsx("span", { className: "dshbg-thumbTag dshbg-tagVideo", children: t("tag.video") }) : null
					]
				}),
				jsx("button", {
					type: "button",
					className: "dshbg-thumbDel",
					"aria-label": t("img.remove"),
					onClick: (event: MouseEvent) => {
						event.stopPropagation();
						onRemove(index);
					},
					children: "×"
				})
			]
		})
	});
}

/** Detailed-parameter text field (draft + commit on blur / Enter). */
function DetailField(props: {
	t: (key: string) => string;
	labelKey: string;
	value: string;
	placeholder?: string;
	onCommit: (value: string) => void;
}) {
	const { t, labelKey, value, placeholder, onCommit } = props;
	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);
	return jsxs("label", {
		className: "dshbg-detailField",
		children: [
			jsx("span", { className: "dshbg-detailLabel", children: t(labelKey) }),
			jsx("input", {
				className: "dshbg-detailInput",
				placeholder,
				value: draft,
				onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
				onBlur: () => onCommit(draft),
				onKeyDown: (event: KeyboardEvent) => {
					if (event.key === "Enter") (event.currentTarget as HTMLInputElement).blur();
				}
			})
		]
	});
}

/** Number field with numeric commit. */
function NumberField(props: {
	t: (key: string) => string;
	labelKey: string;
	value: number;
	min: number;
	max: number;
	onCommit: (value: number) => void;
}) {
	const { t, labelKey, value, min, max, onCommit } = props;
	const [draft, setDraft] = useState(String(value));
	useEffect(() => setDraft(String(value)), [value]);
	return jsxs("label", {
		className: "dshbg-detailField",
		children: [
			jsx("span", { className: "dshbg-detailLabel", children: t(labelKey) }),
			jsx("input", {
				className: "dshbg-detailInput",
				type: "number",
				min,
				max,
				value: draft,
				onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
				onBlur: () => onCommit(Number(draft)),
				onKeyDown: (event: KeyboardEvent) => {
					if (event.key === "Enter") (event.currentTarget as HTMLInputElement).blur();
				}
			})
		]
	});
}

/** Slider row (per-image opacity / blur). */
function SliderRow(props: {
	t: (key: string) => string;
	labelKey: string;
	value: number;
	min: number;
	max: number;
	step: number;
	suffix: string;
	onCommit: (value: number) => void;
}) {
	const { t, labelKey, value, min, max, step, suffix, onCommit } = props;
	return jsxs("div", {
		className: "dshbg-sliderRow",
		children: [
			jsx("span", { className: "dshbg-sliderLabel", children: t(labelKey) }),
			jsx("input", {
				type: "range",
				className: "dshbg-slider",
				min,
				max,
				step,
				value,
				onChange: (event: { target: { value: string } }) => onCommit(Number(event.target.value))
			}),
			jsx("span", { className: "dshbg-sliderValue", children: `${value}${suffix}` })
		]
	});
}

/** Editor panel for the selected image: mode, details, per-image render. */
function EditorPanel(props: {
	t: (key: string) => string;
	img: ImageConfig;
	index: number;
	onUpdate: (index: number, patch: Partial<ImageConfig>) => void;
	onRemove: (index: number) => void;
}) {
	const { t, img, index, onUpdate, onRemove } = props;
	const label = img.source === "file" && img.name !== "" ? img.name : img.url;
	const isVideo = img.media === "video";
	return jsxs("div", {
		className: "dshbg-editor",
		children: [
			jsxs("div", {
				className: "dshbg-editorHead",
				children: [
					jsxs("div", {
						className: "dshbg-editorTitleRow",
						children: [
							jsx("div", { className: "dshbg-editorTitle", children: label }),
							jsx("span", { className: "dshbg-mediaTag", children: t(isVideo ? "media.video" : "media.image") })
						]
					}),
					jsx(Button, {
						variant: "ghost",
						size: "sm",
						onClick: () => onRemove(index),
						children: t("img.remove")
					})
				]
			}),
			jsx("div", {
				className: "dshbg-modeRow",
				children: MODES.map((mode) => jsx("button", {
					type: "button",
					className: `dshbg-modeBtn${img.mode === mode ? " dshbg-selected" : ""}`,
					"aria-pressed": img.mode === mode,
					disabled: isVideo && mode === "repeat",
					title: isVideo && mode === "repeat" ? t("video.repeatDisabled") : undefined,
					onClick: () => onUpdate(index, { mode }),
					children: t(`mode.${mode}`)
				}, mode))
			}),
			img.mode === "custom" ? jsx("div", {
				className: "dshbg-detailGrid",
				children: [
					jsx(DetailField, { t, labelKey: "detail.posX", value: img.posX, onCommit: (v: string) => onUpdate(index, { posX: v }) }),
					jsx(DetailField, { t, labelKey: "detail.posY", value: img.posY, onCommit: (v: string) => onUpdate(index, { posY: v }) }),
					jsx(NumberField, { t, labelKey: "detail.scale", value: img.scale, min: 10, max: 500, onCommit: (v: number) => onUpdate(index, { scale: v }) }),
					jsx(DetailField, { t, labelKey: "detail.width", value: img.width, placeholder: "auto / 800px / 120%", onCommit: (v: string) => onUpdate(index, { width: v }) }),
					jsx(DetailField, { t, labelKey: "detail.height", value: img.height, placeholder: "auto / 600px / 100%", onCommit: (v: string) => onUpdate(index, { height: v }) }),
					!isVideo ? jsxs("label", {
						className: "dshbg-detailField",
						children: [
							jsx("span", { className: "dshbg-detailLabel", children: t("detail.repeat") }),
							jsx("select", {
								className: "dshbg-detailInput",
								value: img.repeat,
								onChange: (event: { target: { value: string } }) => onUpdate(index, { repeat: event.target.value as ImageConfig["repeat"] }),
								children: REPEATS.map((repeat) => jsx("option", { value: repeat, children: t(`repeat.${repeat}`) }, repeat))
							})
						]
					}) : null,
					jsx(NumberField, { t, labelKey: "detail.rotate", value: img.rotate, min: -180, max: 180, onCommit: (v: number) => onUpdate(index, { rotate: v }) }),
					jsx(NumberField, { t, labelKey: "detail.radius", value: img.radius, min: 0, max: 200, onCommit: (v: number) => onUpdate(index, { radius: v }) })
				]
			}) : null,
			jsx(SliderRow, {
				t, labelKey: "render.opacity",
				value: Math.round(img.opacity * 100), min: 0, max: 100, step: 1, suffix: "%",
				onCommit: (v: number) => onUpdate(index, { opacity: v / 100 })
			}),
			jsx(SliderRow, {
				t, labelKey: "render.blur",
				value: Math.round(img.blur), min: 0, max: 24, step: 1, suffix: "px",
				onCommit: (v: number) => onUpdate(index, { blur: v })
			})
		]
	});
}

/** The Background settings section. */
export function BackgroundSection(props: BackgroundSectionProps) {
	const { t, useStore, addImages, removeImage, updateImage, setEnabled, setIntervalSec, setRandom, next, showImage, resolvePreview } = props;
	const s = useStore((state) => state);
	const [area, setArea] = useState<AreaId>("conversation");
	const [urlDraft, setUrlDraft] = useState("");
	const [selected, setSelected] = useState<number | null>(null);
	const [busy, setBusy] = useState(false);
	const [readError, setReadError] = useState(false);
	const [mixError, setMixError] = useState<AddImagesResult | null>(null);
	const cfg = s.areas[area];
	const selectedImg = selected !== null ? cfg.images[selected] : undefined;

	useEffect(() => {
		setSelected(null);
		setMixError(null);
	}, [area]);

	/** Add a batch and surface the single-kind group rule (mixed additions
	 * are skipped and reported inline). */
	const applyAdd = (configs: ImageConfig[]) => {
		const result = addImages(area, configs);
		setMixError(result.skipped > 0 ? result : null);
	};

	const handleFiles = async (files: FileList, accept: PickerAccept, directory: boolean) => {
		setBusy(true);
		try {
			const configs = await importPickedFiles(files, accept, directory);
			if (configs.length > 0) {
				applyAdd(configs);
				setReadError(false);
			} else {
				setReadError(true);
			}
		} finally {
			setBusy(false);
		}
	};

	const onRemove = (index: number) => {
		removeImage(area, index);
		setSelected((current) => (current === null ? null : current >= cfg.images.length - 1 ? Math.max(0, cfg.images.length - 2) : current));
	};

	return jsxs("div", {
		className: "dshbg-root",
		children: [
			jsxs("div", {
				className: "dshbg-head",
				children: [
					jsx("div", { className: "dshbg-title", children: t("title") }),
					jsx("div", { className: "dshbg-sub", children: t("subtitle") })
				]
			}),
			jsx("div", {
				className: "dshbg-seg",
				children: AREAS.map((id) => {
					const active = s.areas[id].enabled && s.areas[id].images.length > 0;
					return jsx("button", {
						type: "button",
						className: `dshbg-segBtn${area === id ? " dshbg-selected" : ""}`,
						"aria-pressed": area === id,
						onClick: () => setArea(id),
						children: [
							jsx("span", { className: "dshbg-dot", "data-active": active }),
							t(`area.${id}`)
						]
					}, id);
				})
			}),
			jsxs("div", {
				className: "dshbg-addRow",
				children: [
					jsx(Input, {
						className: "dshbg-addInput",
						placeholder: t("add.placeholder"),
						value: urlDraft,
						onChange: (event: { target: { value: string } }) => setUrlDraft(event.target.value),
						onKeyDown: (event: KeyboardEvent) => {
							if (event.key === "Enter") {
								applyAdd(parseImageList(urlDraft).map(imageOfUrl));
								setUrlDraft("");
							}
						}
					}),
					jsx(Button, {
						variant: "outline",
						size: "sm",
						onClick: () => {
							applyAdd(parseImageList(urlDraft).map(imageOfUrl));
							setUrlDraft("");
						},
						children: t("add.button")
					}),
					jsx(Button, {
						variant: "outline",
						size: "sm",
						disabled: busy,
						onClick: () => pickFiles("image", false, (files) => void handleFiles(files, "image", false)),
						children: t("add.files")
					}),
					jsx(Button, {
						variant: "outline",
						size: "sm",
						disabled: busy,
						onClick: () => pickFiles("video", false, (files) => void handleFiles(files, "video", false)),
						children: t("add.videos")
					}),
					jsx(Button, {
						variant: "outline",
						size: "sm",
						disabled: busy,
						onClick: () => pickFiles("any", true, (files) => void handleFiles(files, "any", true)),
						children: t("add.folder")
					}),
					jsx(Button, {
						variant: cfg.enabled ? "outline" : "ghost",
						size: "sm",
						onClick: () => setEnabled(area, !cfg.enabled),
						children: cfg.enabled ? t("disable") : t("enable")
					})
				]
			}),
			cfg.images.length > 0 ? jsx("div", {
				className: "dshbg-strip",
				children: cfg.images.map((img, index) => jsx(StripItem, {
					t,
					img,
					index,
					selected: selected === index,
					onSelect: (i: number) => {
						setSelected(i);
						showImage(area, i);
					},
					onRemove,
					resolvePreview
				}, `${area}-${index}`))
			}) : jsx("div", { className: "dshbg-empty", children: t("list.empty") }),
			selectedImg !== undefined ? jsx(EditorPanel, {
				t,
				img: selectedImg,
				index: selected as number,
				onUpdate: (index: number, patch: Partial<ImageConfig>) => updateImage(area, index, patch),
				onRemove
			}) : null,
			jsxs("div", {
				className: "dshbg-playRow",
				children: [
					jsx("span", { className: "dshbg-intervalLabel", children: t("play.interval") }),
					jsx(Input, {
						className: "dshbg-intervalInput",
						type: "number",
						min: 0,
						max: 3600,
						value: cfg.intervalSec,
						onChange: (event: { target: { value: string } }) => setIntervalSec(area, Number(event.target.value))
					}),
					jsx(Button, {
						variant: cfg.random ? "outline" : "ghost",
						size: "sm",
						onClick: () => setRandom(area, !cfg.random),
						children: cfg.random ? t("play.random") : t("play.order")
					}),
					jsx(Button, {
						variant: "ghost",
						size: "sm",
						disabled: cfg.images.length < 2,
						onClick: () => next(area),
						children: t("play.next")
					}),
					jsx("span", {
						className: "dshbg-position",
						children: cfg.images.length > 0 ? `${cfg.index + 1}/${cfg.images.length}` : "0/0"
					})
				]
			}),
			s.lastError !== null ? jsx("div", { className: "dshbg-error", role: "alert", children: t(`error.${s.lastError}`) }) : null,
			mixError !== null ? jsx("div", {
				className: "dshbg-error",
				role: "alert",
				children: t("error.mixed").replace("{n}", String(mixError.skipped)).replace("{kind}", t(mixError.skippedKind === "video" ? "media.video" : "media.image"))
			}) : null,
			readError ? jsx("div", { className: "dshbg-error", role: "alert", children: t("error.read") }) : null
		]
	});
}

/**
 * The plugin config card (Settings → Plugins): an expandable shell whose body
 * is the full Background editor. The card slots into the `settings.plugin.item`
 * list, so it renders an `<li>` and draws its own chrome.
 */
export function BackgroundCard(props: BackgroundSectionProps) {
	const { t } = props;
	// Collapsed by default, matching the built-in plugin cards.
	const [open, setOpen] = useState(false);
	return jsxs("li", {
		className: `dshbg-card${open ? " dshbg-open" : ""}`,
		children: [
			jsx("button", {
				type: "button",
				className: "dshbg-cardHeader",
				"aria-expanded": open,
				"aria-label": `${open ? t("card.collapse") : t("card.expand")}: ${t("card.name")}`,
				onClick: () => setOpen(!open),
				children: jsxs(Fragment, {
					children: [
						jsxs("span", {
							className: "dshbg-cardHeadText",
							children: [
								jsx("span", { className: "dshbg-cardName", children: t("card.name") }),
								jsx("span", { className: "dshbg-cardDesc", children: t("card.description") })
							]
						}),
						jsx(IconChevronDownOutline14, {
							className: `dshbg-cardChevron${open ? " dshbg-chevronOpen" : ""}`,
							size: 14
						})
					]
				})
			}),
			open ? jsx("div", {
				className: "dshbg-cardBody",
				children: jsx(BackgroundSection, props)
			}) : null
		]
	});
}
