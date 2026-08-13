/**
 * src/vendor.d.ts — ambient declarations for browser/platform modules the
 * bundle requires at runtime (kept minimal so the plugin type-checks without
 * installing @types/* packages).
 */

declare module "cordis" {
	/** Minimal Context surface used by the server-side plugin face. */
	export interface Context {
		[key: string]: any;
	}
}

declare module "react" {
	export function useState<T>(init: T | (() => T)): [T, (value: T | ((prev: T) => T)) => void];
	export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
	export function useRef<T>(init: T): { current: T };
	export function useMemo<T>(factory: () => T, deps?: readonly unknown[]): T;
}

declare module "react/jsx-runtime" {
	export function jsx(type: unknown, props: any, key?: unknown): any;
	export function jsxs(type: unknown, props: any, key?: unknown): any;
	export const Fragment: unknown;
}

declare module "@deepseek-ai/dsh-client-ui-primitives" {
	export function Button(props: Record<string, any>): any;
	export function Input(props: Record<string, any>): any;
	export function IconChevronDownOutline14(props: Record<string, any>): any;
}

declare module "@deepseek-ai/dsh-client-runtime/client" {
	export interface StoreHandle {
		spec: unknown;
		create(scopeKey?: string): any;
	}
	export function defineStore(decl: {
		init: () => unknown;
		persist?: string;
		actions: Record<string, (draft: any, ...args: any[]) => void>;
	}): StoreHandle;
}
