import { delimiter } from 'node:path'
import { expect, it } from 'vitest'
import { desktopNodeEnvironment } from '../src/node-environment.ts'

it('keeps private Desktop launchers out of the Host environment inherited by PTC', () => {
  const environment = { PATH: '/user/bin', HOME: '/user' }
  expect(desktopNodeEnvironment('/desktop/electron', undefined, environment)).toEqual({
    ...environment, ELECTRON_RUN_AS_NODE: '1',
  })
  expect(environment).toEqual({ PATH: '/user/bin', HOME: '/user' })
})

it('provides private launchers only to package installation processes', () => {
  expect(desktopNodeEnvironment('/desktop/electron', '/desktop/bin', { PATH: '/user/bin' })).toEqual({
    ELECTRON_RUN_AS_NODE: '1',
    DSH_DESKTOP_NODE_EXECUTABLE: '/desktop/electron',
    PATH: `/desktop/bin${delimiter}/user/bin`,
  })
})

it('withholds an inherited NODE_PATH from the Node-mode child', () => {
  const environment = { PATH: '/user/bin', HOME: '/user', NODE_PATH: '/foreign.app/node_modules' }
  expect(desktopNodeEnvironment('/desktop/electron', undefined, environment)).toEqual({
    PATH: '/user/bin', HOME: '/user', ELECTRON_RUN_AS_NODE: '1',
  })
  expect(desktopNodeEnvironment('/desktop/electron', '/desktop/bin', environment).NODE_PATH).toBeUndefined()
  expect(environment).toEqual({ PATH: '/user/bin', HOME: '/user', NODE_PATH: '/foreign.app/node_modules' })
})
