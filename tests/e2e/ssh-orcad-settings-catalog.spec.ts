import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { startOrcadConvertHost } from './helpers/orcad-convert-host'
import { waitForSessionReady } from './helpers/store'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'

const TEMPLATE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
test.skip(!TEMPLATE || process.env.ORCA_E2E_SSH_DOCKER !== '1', 'Needs Docker and server template')

test('open Remote Settings follows a newly connected managed host', async (// oxlint-disable-next-line no-empty-pattern -- This test owns its app launch.
{}, testInfo) => {
  test.setTimeout(3 * 60_000)
  const host = startOrcadConvertHost('docker', testInfo)
  const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE! })
  let app: ElectronApplication | null = null
  try {
    const launched = await session.launch()
    app = launched.app
    const page = launched.page
    await waitForSessionReady(page)
    await page.evaluate(() => {
      const state = window.__store?.getState()
      state?.openSettingsTarget({ pane: 'servers', repoId: null })
      state?.openSettingsPage()
    })
    await expect(page.getByPlaceholder('Search settings')).toBeVisible()
    await dismissTransientAnnouncement(page)
    await expect(page.getByText('No saved servers.', { exact: true })).toBeVisible()
    const connected = await page.evaluate(async (input) => {
      const { target } = await window.api.ssh.addTarget({ target: input })
      const state = await window.api.ssh.connect({ targetId: target.id })
      return { targetId: target.id, server: state?.managedServer }
    }, host.input)
    if (connected.server?.kind !== 'managed') {
      throw new Error(`Expected managed server: ${JSON.stringify(connected)}`)
    }
    const environmentId = connected.server.environmentId
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            window.__store?.getState().runtimeEnvironments.map((entry) => entry.id)
          ),
        { timeout: 60_000 }
      )
      .toContain(environmentId)
    console.log(
      '[settings-live-catalog]',
      JSON.stringify({
        connected,
        catalog: await page.evaluate(() =>
          window.__store
            ?.getState()
            .runtimeEnvironments.map((entry) => ({ id: entry.id, name: entry.name }))
        ),
        stillEmpty: await page.getByText('No saved servers.', { exact: true }).isVisible()
      })
    )
    await page
      .locator('.settings-view-shell')
      .screenshot({ path: testInfo.outputPath('settings-live-catalog.png') })
    await expect(page.getByText('No saved servers.', { exact: true })).toBeHidden({
      timeout: 15_000
    })
    await expect(
      page
        .locator('[data-settings-section="managed-servers"]')
        .getByRole('button', { name: 'Stop…', exact: true })
    ).toBeVisible()
    await page
      .locator('.settings-view-shell')
      .screenshot({ path: testInfo.outputPath('settings-live-catalog-ready.png') })
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    host.cleanup()
  }
})
