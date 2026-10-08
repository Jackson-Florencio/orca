import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { startOrcadConvertHost } from './helpers/orcad-convert-host'
import { waitForSessionReady } from './helpers/store'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'

const TEMPLATE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
test.skip(!TEMPLATE || process.env.ORCA_E2E_SSH_DOCKER !== '1', 'Needs Docker and server template')

test('an idle active server explains why Stop is refused', async (// oxlint-disable-next-line no-empty-pattern -- This test owns its app launch.
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
      .poll(() =>
        page.evaluate(() => window.__store?.getState().runtimeEnvironments.map((e) => e.id))
      )
      .toContain(environmentId)
    await page.evaluate(() => {
      const state = window.__store?.getState()
      state?.openSettingsTarget({ pane: 'servers', repoId: null })
      state?.openSettingsPage()
    })
    await expect(page.getByPlaceholder('Search settings')).toBeVisible()
    await dismissTransientAnnouncement(page)
    await page
      .locator('[data-settings-section="default-runtime"]')
      .getByRole('button', { name: 'Advanced', exact: true })
      .click()
    await page.getByRole('combobox', { name: 'Active Server', exact: true }).click()
    await page.getByRole('option', { name: host.input.label, exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Switch', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect
      .poll(() =>
        page.evaluate(() => window.__store?.getState().settings?.activeRuntimeEnvironmentId)
      )
      .toBe(environmentId)
    await expect(page.getByText(`Switched to ${host.input.label}.`, { exact: true })).toBeHidden({
      timeout: 15_000
    })
    const census = await page.evaluate(
      (selector) => window.api.runtimeEnvironments.managedOrcad.getStatus({ selector }),
      environmentId
    )
    expect(census.terminals.liveSessions).toBe(0)
    const refusal = await page.evaluate(
      (selector) => window.api.runtimeEnvironments.managedOrcad.stop({ selector }),
      environmentId
    )
    expect(refusal).toMatchObject({
      outcome: 'refused',
      verdict: 'live',
      code: 'orcad_stop_active_environment'
    })
    console.log(
      '[active-stop-refusal]',
      JSON.stringify({ environmentId, census: census.terminals, refusal })
    )
    const section = page.locator('[data-settings-section="managed-servers"]')
    await expect(section.getByText('Running terminals: 0', { exact: true })).toBeVisible()
    await section.getByRole('button', { name: 'Stop…', exact: true }).click()
    await section.getByRole('button', { name: 'Stop and remove server', exact: true }).click()
    await expect.poll(() => page.locator('[data-sonner-toast]').count()).toBeGreaterThan(0)
    await page
      .locator('.settings-view-shell')
      .screenshot({ path: testInfo.outputPath('active-stop.png') })
    await expect(
      page.getByText(
        'Not done: choose another Active Server in Advanced before stopping this server.',
        { exact: true }
      )
    ).toBeVisible()
    await expect(
      page.getByText(
        'Not done: terminals on this server are still running. Close them and try again.',
        { exact: true }
      )
    ).toBeHidden()
    const after = await page.evaluate(
      (selector) => window.api.runtimeEnvironments.managedOrcad.getStatus({ selector }),
      environmentId
    )
    expect(after.terminals.liveSessions).toBe(0)
    expect(after.activeVersion).toBe(census.activeVersion)
    await expect(section.getByRole('button', { name: 'Stop…', exact: true })).toBeVisible()
    await page
      .locator('.settings-view-shell')
      .screenshot({ path: testInfo.outputPath('active-stop-ready.png') })
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    host.cleanup()
  }
})
