import { readFileSync, rmSync } from 'node:fs'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { startOrcadConvertHost } from './helpers/orcad-convert-host'
import { createRestartSession } from './helpers/orca-restart'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import { convertAndRetain, reconnect, serverCall } from './helpers/orcad-convert-flow'
import { createPairedHostTerminal, openPairedClientTab } from './helpers/paired-host-terminal'
import { focusActiveTerminalInput } from './helpers/terminal'
import { expectTerminalAccessibilityText } from './helpers/terminal-accessibility-tree'
import {
  createRetentionFixtureDirectory,
  writeRetentionFixture
} from './helpers/host-created-terminal-retention-oracle'
import { orcaCliResult } from './helpers/compiled-orca-cli'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'
import { shellEscape } from '../../src/main/ssh/ssh-connection-utils'

const TEMPLATE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
test.skip(
  !TEMPLATE || process.env.ORCA_E2E_SSH_DOCKER !== '1',
  'Needs the Docker SSH host and server template'
)

test('converted host redeploys after its Git identity cache changes and an idle stop', async (// oxlint-disable-next-line no-empty-pattern -- This exercise owns its launches.
{}, testInfo) => {
  test.setTimeout(5 * 60_000)
  const host = startOrcadConvertHost('docker', testInfo)
  const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE! })
  const fixtureDirectory = createRetentionFixtureDirectory()
  let app: ElectronApplication | null = null
  try {
    if (!host.exec) {
      throw new Error('Docker controls are unavailable')
    }
    const exec = host.exec
    const first = await session.launch()
    app = first.app
    await session.close(app)
    app = null
    const seeded = seedRelayEraProfile(session.userDataDir, host.input, {
      repoPath: host.remoteRepoPath,
      folderPath: host.remoteFolderPath
    })
    const current = await session.launch()
    app = current.app
    const page = current.page
    await convertAndRetain(page, session.userDataDir, seeded)
    const environment = (await page.evaluate(() => window.api.runtimeEnvironments.list())).find(
      (entry) => entry.orcadDeployment?.sshTargetId === seeded.targetId
    )
    if (!environment) {
      throw new Error('Managed host was not registered')
    }
    const fixture = writeRetentionFixture(fixtureDirectory)
    const remoteFixture = '/tmp/orca-server-restart-input.mjs'
    const sink = '/tmp/orca-server-restart-input.log'
    exec(
      `printf '%s' ${shellEscape(readFileSync(fixture, 'utf8'))} > ${shellEscape(remoteFixture)}`
    )
    const terminal = await createPairedHostTerminal(
      page,
      environment.id,
      seeded.worktreeId,
      `node ${shellEscape(remoteFixture)} ${shellEscape(sink)}`
    )
    await openPairedClientTab(page, seeded.worktreeId, terminal.webTabId)
    await expectTerminalAccessibilityText(page, terminal.webTabId, 'READY:')
    const typeLine = async (line: string): Promise<void> => {
      await focusActiveTerminalInput(page)
      await page.keyboard.type(line)
      await page.keyboard.press('Enter')
    }
    const runId = Date.now()
    const before = `BEFORE_${runId}`
    await typeLine(before)
    await expectTerminalAccessibilityText(page, terminal.webTabId, `LINE:${before}`)
    const beforeLedger = exec(`cat ${shellEscape(sink)}`)
    await expect
      .poll(async () => JSON.parse(await serverCall(page, environment.id, 'repo.list', {})), {
        timeout: 30_000
      })
      .toMatchObject({ result: { repos: [expect.objectContaining({ gitRemoteIdentity: null })] } })
    await page.evaluate(() => {
      const state = window.__store?.getState()
      state?.openSettingsTarget({ pane: 'servers', repoId: null })
      state?.openSettingsPage()
    })
    await expect(page.getByPlaceholder('Search settings')).toBeVisible()
    await dismissTransientAnnouncement(page)
    const managed = page.locator('[data-settings-section="managed-servers"]')
    await expect(managed).toBeVisible()
    const row = managed.locator('div.space-y-2.px-4.py-3').filter({ hasText: environment.name })
    await expect(row.getByRole('button', { name: 'Stop…', exact: true })).toBeEnabled({
      timeout: 60_000
    })
    await row.getByRole('button', { name: 'Stop…', exact: true }).click()
    await row.getByRole('button', { name: 'Stop and remove server', exact: true }).click()
    await expect(page.getByText(/terminals on this server are still running/)).toBeVisible({
      timeout: 60_000
    })
    const pid = beforeLedger
      .split('\n')
      .find((line) => line.startsWith('READY:'))
      ?.slice(6)
    if (!pid) {
      throw new Error('Fixture PID missing')
    }
    expect(exec(`kill -0 ${shellEscape(pid)} && echo live`).trim()).toBe('live')
    expect(
      (await page.evaluate(() => window.api.runtimeEnvironments.list())).map((item) => item.id)
    ).toContain(environment.id)
    await page.screenshot({ path: testInfo.outputPath('managed-stop-live-refusal.png') })
    await orcaCliResult(session.userDataDir, [
      'terminal',
      'close',
      '--environment',
      environment.id,
      '--worktree',
      `id:${seeded.worktreeId}`,
      '--all'
    ])
    await expect
      .poll(
        async () => {
          const response = await page.evaluate(
            async (id) => window.api.runtimeEnvironments.managedOrcad?.getStatus({ selector: id }),
            environment.id
          )
          return response?.terminals.liveSessions
        },
        { timeout: 60_000 }
      )
      .toBe(0)
    await row.getByRole('button', { name: 'Stop…', exact: true }).click()
    await row.getByRole('button', { name: 'Stop and remove server', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.api.runtimeEnvironments.list())).map((item) => item.id),
        { timeout: 120_000 }
      )
      .not.toContain(environment.id)
    await expect(row).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('managed-stop-unlinked.png') })
    const reconnectResult = JSON.parse(await reconnect(page, seeded.targetId))
    console.log('[managed-stop-reconnect-result]', JSON.stringify(reconnectResult))
    await page
      .locator('.settings-view-shell')
      .screenshot({ path: testInfo.outputPath('managed-stop-reconnect-result.png') })
    expect(reconnectResult).toMatchObject({ kind: 'managed' })
    const redeployed = (await page.evaluate(() => window.api.runtimeEnvironments.list())).find(
      (item) => item.orcadDeployment?.sshTargetId === seeded.targetId
    )
    if (!redeployed) {
      throw new Error('Redeployed environment was not registered')
    }
    await page.evaluate(() => {
      const state = window.__store?.getState()
      state?.closeSettingsPage()
      state?.openSettingsTarget({ pane: 'servers', repoId: null })
    })
    await expect(page.getByPlaceholder('Search settings')).toBeHidden()
    await page.evaluate(() => window.__store?.getState().openSettingsPage())
    await expect(managed.getByRole('button', { name: 'Stop…', exact: true })).toBeVisible({
      timeout: 30_000
    })
    await expect
      .poll(async () => JSON.parse(await serverCall(page, redeployed.id, 'repo.list', {})))
      .toMatchObject({
        result: {
          repos: [expect.objectContaining({ path: host.remoteRepoPath, gitRemoteIdentity: null })]
        }
      })
    await expect
      .poll(() =>
        page.locator('.settings-view-shell').evaluate((element) => {
          let opacity = 1
          for (let current: Element | null = element; current; current = current.parentElement) {
            opacity *= Number(getComputedStyle(current).opacity)
          }
          return opacity
        })
      )
      .toBe(1)
    await page
      .locator('.settings-view-shell')
      .screenshot({ path: testInfo.outputPath('managed-stop-redeployed-visible.png') })
    console.log(
      '[managed-stop-redeploy]',
      JSON.stringify({ original: environment.id, redeployed: redeployed?.id, beforeLedger })
    )
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    host.cleanup()
    rmSync(fixtureDirectory, { recursive: true, force: true })
  }
})
