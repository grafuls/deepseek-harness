/**
 * Collab workspaces manager, node half. The plugin is entirely browser-side
 * (exports["./client"], declared by the package.json `dsh.client` manifest);
 * this node entry provides an inert `apply` so the Loader can mount the row
 * as an ordinary plugin and the modules node half can serve the client
 * bundle. It registers no host-side behavior.
 * @module @deepseek-ai/dsh-client-ui-collab
 */

/** Provides no host-side behavior for the workspaces manager. */
export function apply(): void {}
