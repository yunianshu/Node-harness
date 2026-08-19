import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NovelHarnessApp } from '../../src/app'
import { FakeHost } from '../../src/host/dsh-adapter'
import type { ModelGateway } from '../../src/model/gateway'

/** 最小网关：规划失败场景不会触达模型调用，各角色直接返回空 JSON。 */
const noopGateway = {
  setBindings: () => {},
  channelStatus: () => [] as const,
  invoke: async () => ({ content: '{}', finishReason: 'stop' as const, usage: null, raw: {} }),
  invokeStream: async () => ({ content: '{}', finishReason: 'stop' as const, usage: null, raw: {} }),
} as unknown as ModelGateway

describe('阶段失败回滚（runPhase 统一处理）', () => {
  let root: string
  let packRoot: string
  let app: NovelHarnessApp

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'phase-fail-'))
    packRoot = await mkdtemp(join(tmpdir(), 'phase-pack-'))
    // generic 包 schema 合法但 checklist 锚点与 anchors 不对应：
    // list()（仅 schema 校验）放行、create 可建，但 runPhase 装载（额外校验锚点对应）时抛错——
    // 精确复现 C 层「create 成功但 start 时风格包加载失败」的真实路径。
    await mkdir(join(packRoot, 'generic'))
    await writeFile(
      join(packRoot, 'generic', 'pack.json'),
      JSON.stringify({
        packId: 'generic',
        displayName: 'generic 测试包',
        anchors: [{ anchorId: 'a', level: 'core', rule: '一个锚点' }],
        exemplars: [
          { plain: 'p1', styled: 's1' },
          { plain: 'p2', styled: 's2' },
          { plain: 'p3', styled: 's3' },
        ],
        checklist: [{ anchorId: 'missing', question: '与锚点不对应' }],
      }),
    )
    app = new NovelHarnessApp({ dataRoot: root, host: new FakeHost(root), stylePackRoot: packRoot, gateway: noopGateway })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(packRoot, { recursive: true, force: true })
  })

  it('loadPhaseContext 抛错时回滚为 paused 并释放锁（可再次启动）', async () => {
    const created = await app.projects.create(
      { name: '失败回滚', premise: '刀客为查旧案真相重回故地，雪夜长街，故人重逢，真相渐近。', totalChapters: 1, stylePackId: 'generic' },
      'test',
    )
    const projectId = created.project.projectId
    await app.projects.start(projectId)
    expect((await app.projects.loadProject(projectId)).status).toBe('planning')

    // 装载风格包抛「检查清单必须与锚点一一对应」，runPhase 失败
    await expect(app.scheduler.runPhase(projectId, new AbortController().signal)).rejects.toThrow(/检查清单/)
    // 状态回滚到 paused
    expect((await app.projects.loadProject(projectId)).status).toBe('paused')
    // 锁已释放：再次启动不再 ALREADY_RUNNING
    await expect(app.projects.start(projectId)).resolves.toBeDefined()
  })
})
