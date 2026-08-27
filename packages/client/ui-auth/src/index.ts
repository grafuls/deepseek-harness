/**
 * Collab sign-in gate, node half. The plugin is almost entirely browser-side
 * (exports["./client"], declared by the package.json `dsh.client` manifest);
 * this node entry provides an inert `apply` so the Loader can mount the row
 * as an ordinary plugin and the modules node half can serve the client
 * bundle. Given no OIDC creds or journaling duties, it performs no work.
 * @module @deepseek-ai/dsh-client-ui-auth
 */

/** Provides no host-side behavior for the collab sign-in gate. */
export function apply(): void {}
