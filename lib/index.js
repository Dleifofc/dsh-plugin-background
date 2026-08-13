/**
 * dsh-plugin-background — server-side half.
 *
 * The background feature itself is browser-only: the client bundle
 * (`exports["./client"]`, built by esbuild) paints the layers and owns the
 * settings section. This entry exists so the profile loader mounts the
 * package; the client-modules scan composes browser bundles from exactly
 * these loader entries (keyed on the package's `dsh.client` metadata), so a
 * server-side plugin row is what puts the client bundle into
 * `window.__DSH_BOOT__`.
 *
 * Why plain JS and not a `.ts` source (src/index.ts exists as the
 * doc-convention reference): the official "first plugin" tutorial loads
 * TypeScript sources directly only when they live OUTSIDE node_modules
 * (project-relative `name: './src/my-plugin.ts'`). Plugins installed into a
 * profile's node_modules cannot ship `.ts` entry points — Node refuses
 * type-stripping under node_modules
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) — and the client-modules
 * scan additionally requires the entry name to be the package name so it can
 * resolve package.json for the `dsh.client` declaration. Hence the server
 * half stays a tiny ESM JS file.
 */
/** Stable cordis plugin name (the loader entry id stays the package name). */
export const name = "ui-background";

/** No server services are required before this plugin activates. */
export const inject = [];

/**
 * Mount the server-side half. Deliberately inert: everything this plugin
 * does happens in the browser bundle.
 * @param ctx - the profile's root cordis context.
 */
export function apply(ctx) {
  // Browser-only feature; nothing to mount server-side.
  void ctx;
}
