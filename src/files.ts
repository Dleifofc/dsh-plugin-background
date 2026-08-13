/**
 * src/files.ts — file / folder pickers. Local media (images, GIFs, videos)
 * are stored in IndexedDB as their original Blob (never base64-packed);
 * display happens lazily via object URLs created by the service.
 */
import { idbPutFile, idbDeleteFile } from "./persistence";
import { imageOfFile, makeId, mediaOfName } from "./constants";
import type { ImageConfig, MediaType } from "./types";

/** What a picker accepts: images only, videos only, or anything (folders). */
export type PickerAccept = "image" | "video" | "any";

/** Programmatically open a file / folder picker and report the FileList. */
export function pickFiles(accept: PickerAccept, directory: boolean, onFiles: (files: FileList) => void): void {
	const input = document.createElement("input");
	input.type = "file";
	if (accept === "image") input.accept = "image/*";
	else if (accept === "video") input.accept = "video/*";
	input.multiple = true;
	if (directory) input.setAttribute("webkitdirectory", "");
	input.style.display = "none";
	document.body.appendChild(input);
	input.addEventListener("change", () => {
		if (input.files !== null) onFiles(input.files);
		input.remove();
	});
	input.click();
}

/** True when a file looks like an accepted image or video. */
function acceptable(file: File, accept: PickerAccept): boolean {
	if (accept === "image") return file.type.startsWith("image/") || (file.type === "" && mediaOfName(file.name) === "image");
	if (accept === "video") return file.type.startsWith("video/") || (file.type === "" && mediaOfName(file.name) === "video");
	// any (folder import): keep every image or video by type / extension
	if (file.type !== "") return file.type.startsWith("image/") || file.type.startsWith("video/");
	return mediaOfName(file.name) !== "image" || true; // unknown type: accept, media resolved by name
}

/** Resolve the media kind of a picked file (type first, then extension). */
function mediaOf(file: File): MediaType {
	if (file.type.startsWith("video/")) return "video";
	if (file.type.startsWith("image/")) return "image";
	return mediaOfName(file.name);
}

/**
 * Import picked files into IndexedDB and build image configs. Folder picks
 * keep only direct children (non-recursive: the relative path must be
 * exactly "folder/file"). Unreadable files are skipped.
 */
export async function importPickedFiles(files: FileList, accept: PickerAccept, directory: boolean): Promise<ImageConfig[]> {
	const configs: ImageConfig[] = [];
	for (const file of Array.from(files)) {
		if (!acceptable(file, accept)) continue;
		if (directory && (file.webkitRelativePath ?? "").split("/").length !== 2) continue;
		try {
			const fileId = makeId();
			// Read the bytes explicitly and store {buffer, type} — storing the
			// File object itself can structured-clone into a zero-byte blob.
			const buffer = await file.arrayBuffer();
			await idbPutFile(fileId, { buffer, type: file.type });
			configs.push(imageOfFile(fileId, file.name, mediaOf(file)));
		} catch {
			// unreadable file: skip
		}
	}
	return configs;
}

/** Delete a stored file blob (media removal). */
export function deleteStoredFile(fileId: string): void {
	void idbDeleteFile(fileId);
}
