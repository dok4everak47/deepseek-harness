/** Electron Node-mode startup, with private shell launchers scoped to package installation. */

import { delimiter } from 'node:path'

/**
 * Inherited variables that redirect where the Node-mode child loads code from.
 * `NODE_PATH` applies to the shipped runtime too, so a value exported by another
 * application resolves `@img/*` and similar packages outside this bundle and fails
 * Host startup with `DesktopHostFatalError`.
 */
const MODULE_RESOLUTION_NAMES: readonly string[] = ['NODE_PATH']

/**
 * Select Electron's Node mode and the shell launcher used by package scripts.
 * @param executable - Electron executable running the application.
 * @param bin - Directory containing the node shell launcher.
 * @param environment - Caller environment preserved for plugin execution, minus
 *   {@link MODULE_RESOLUTION_NAMES}, which the shipped runtime must not inherit.
 * @returns Environment for a Node-mode child process.
 */
export function desktopNodeEnvironment(executable: string, bin: string | undefined, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(environment).filter(([name]) => !MODULE_RESOLUTION_NAMES.includes(name)),
  )
  return {
    ...inherited,
    ELECTRON_RUN_AS_NODE: '1',
    ...(bin === undefined ? {} : { DSH_DESKTOP_NODE_EXECUTABLE: executable, PATH: `${bin}${delimiter}${inherited.PATH ?? ''}` }),
  }
}
