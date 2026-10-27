/**
 * dsh-pet 桌面宠物插件集成：注册 google-antigravity 专属的自定义多页余额气泡。
 *
 * 采用 dsh-pet 的 `shape: 'custom'` 规范：
 * - 声明式节点树，两端共用白名单渲染器，不修改 dsh-pet 公共层；
 * - 气泡顶端明确标注 `google-antigravity` 与模型分组标签（Gemini / Claude）；
 * - 额度统一展示为「剩余 XX%」，进度条如实体现剩余健康度；
 * - 多页循环切换：Gemini 与 Claude / 3P 分组各占一页，自动根据当前选中的模型优先排在首页；
 * - 计算当前组最告急窗口的已用百分比（0-100）作为 `percent`，驱动桌宠档位动画。
 *
 * @module antigravity-auth/pet-balance
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AntigravityAuthService } from './auth-service.ts'
import type { QuotaStatusView, QuotaWindowView } from './quota.ts'

const INK = '#1f1f1f'
const MUTED = 'rgba(43,43,43,.6)'
const TRACK = 'rgba(43,43,43,.12)'

/** 自定义节点类型定义（与 dsh-pet CustomNode 对齐） */
export interface PetCustomNode {
  tag: 'div' | 'span' | 'i' | 'b' | 'strong' | 'em' | 'img'
  text?: string
  src?: string
  style?: Record<string, string>
  children?: PetCustomNode[]
}

export interface PetCustomBalanceResult {
  ok: true
  provider: string
  shape: 'custom'
  data: {
    views: PetCustomNode[]
    percent?: number
  }
}

/** 剩余百分比对应的进度条色彩（剩余充足为绿，剩余 <= 30% 为橙黄，剩余 <= 10% 为危急红） */
function petBarColor(remPct: number): string {
  if (remPct <= 10) return '#e53935'
  if (remPct <= 30) return '#e8952f'
  return '#2e9e4f'
}

/** ISO 重置时间转相对倒计时文案 */
function petResetInText(iso?: string): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const delta = t - Date.now()
  if (delta <= 0) return '已重置'
  const hoursF = delta / 3_600_000
  if (hoursF >= 96) return `${(Math.round((hoursF / 24) * 10) / 10).toFixed(1)} 天重置`
  return `${Math.max(0.1, Math.round(hoursF * 10) / 10).toFixed(1)} 小时重置`
}

/** 构建一个模型分组对应的声明式视图页 */
function createPetGroupPage(
  badgeLabel: string,
  pageIndex: number,
  totalPages: number,
  windows: readonly QuotaWindowView[],
  hint: string,
): PetCustomNode {
  const win5h = windows.find(w => w.window === '5h')
  const winWeekly = windows.find(w => w.window === 'weekly')

  const children: PetCustomNode[] = [
    // 顶部标题栏：服务商标头 + 分组标签 + 页码
    {
      tag: 'div',
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25em' },
      children: [
        {
          tag: 'div',
          style: { display: 'flex', alignItems: 'center', gap: '0.3em' },
          children: [
            { tag: 'span', text: 'google-antigravity', style: { fontSize: '0.82em', fontWeight: '650', color: INK } },
            {
              tag: 'span',
              text: badgeLabel,
              style: {
                fontSize: '0.62em',
                color: '#2e9e4f',
                border: '1px solid rgba(46,158,79,.5)',
                borderRadius: '0.25em',
                padding: '0 0.25em',
              },
            },
          ],
        },
        totalPages > 1
          ? {
              tag: 'span',
              text: `${pageIndex + 1}/${totalPages} ›`,
              style: { fontSize: '0.68em', color: MUTED },
            }
          : { tag: 'span' },
      ],
    },
  ]

  // 渲染有效窗口（5h 滚动窗口、每周配额窗口）
  const validWindows = [win5h, winWeekly].filter((w): w is QuotaWindowView => w !== undefined)
  for (const win of validWindows) {
    const label = win.window === '5h' ? '5h 额度' : '周额度'
    const fraction = typeof win.remainingFraction === 'number' ? win.remainingFraction : 1
    const remPct = Math.max(0, Math.min(100, Math.round(fraction * 100)))
    const color = petBarColor(remPct)
    const reset = petResetInText(win.resetTime)

    children.push({
      tag: 'div',
      style: { marginTop: '0.2em' },
      children: [
        {
          tag: 'div',
          style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.3em' },
          children: [
            { tag: 'span', text: label, style: { fontSize: '0.75em', color: MUTED } },
            { tag: 'span', text: `剩余 ${remPct}%`, style: { fontSize: '0.8em', fontWeight: '650', color: INK } },
          ],
        },
        {
          tag: 'div',
          style: { display: 'flex', alignItems: 'center', gap: '0.3em', marginTop: '0.12em' },
          children: [
            {
              tag: 'div',
              style: { flex: '1 1 auto', height: '0.3em', borderRadius: '0.15em', background: TRACK, overflow: 'hidden' },
              children: [
                {
                  tag: 'i',
                  style: { display: 'block', height: '100%', width: `${remPct}%`, background: color },
                },
              ],
            },
            reset
              ? {
                  tag: 'span',
                  text: reset,
                  style: { fontSize: '0.7em', color: MUTED, whiteSpace: 'nowrap' },
                }
              : { tag: 'span' },
          ],
        },
      ],
    })
  }

  // 多页时的底部切换提示
  if (totalPages > 1 && hint) {
    children.push({
      tag: 'div',
      style: { fontSize: '0.65em', color: MUTED, marginTop: '0.3em', textAlign: 'center' },
      text: hint,
    })
  }

  return {
    tag: 'div',
    style: { minWidth: '13em' },
    children,
  }
}

/**
 * 监听 `petApi7340` 服务并在在场时注册 `google-antigravity` 自定义多页余额服务商。
 *
 * @param ctx 宿主 Cordis Context
 * @param service Antigravity 认证服务
 */
export function registerAntigravityPetBalance(ctx: Context, service: AntigravityAuthService): void {
  type DefaultModelService = { currentSelection?: () => { model?: string } }
  const dynamicCtx = ctx as Context & {
    inject?: (deps: string[], cb: (injectedCtx: Record<string, unknown>) => (() => void) | void) => void
    get?: (name: string) => unknown
    agentDefaultModel?: DefaultModelService
  }

  dynamicCtx.inject?.(['petApi7340'], (petCtx) => {
    const api = petCtx.petApi7340 as
      | { balance?: { register?: (def: { id: string; fetch: (args: { provider: string }) => Promise<PetCustomBalanceResult> }) => () => void } }
      | undefined

    const unregister = api?.balance?.register?.({
      id: 'google-antigravity',
      async fetch({ provider }): Promise<PetCustomBalanceResult> {
        const usage: QuotaStatusView = await service.usage()
        if (!usage || typeof usage !== 'object') {
          throw new Error('Antigravity 配额不可用')
        }
        if (usage.state === 'unauthenticated') {
          throw new Error('Antigravity 未登录，请先在设置中完成 Google 授权')
        }
        if (usage.state === 'rate-limited') {
          throw new Error('Antigravity 配额查询被限流，请稍后重试')
        }
        if (usage.state === 'forbidden') {
          throw new Error('当前账号无权查询 Antigravity 配额')
        }
        if (usage.state !== 'available') {
          throw new Error(`Antigravity 配额状态异常（${usage.state}）`)
        }

        const groups = Array.isArray(usage.groups) ? usage.groups : []
        if (groups.length === 0) {
          throw new Error('Antigravity 响应缺少配额分组')
        }

        const geminiGroup = groups.find(g => g.group === 'gemini')
        const nonGeminiGroup = groups.find(g => g.group === 'non-gemini')

        let currentModel = ''
        try {
          const modelSvc = (
            (petCtx as { get?: (name: string) => unknown }).get?.('agentDefaultModel')
            ?? dynamicCtx.get?.('agentDefaultModel')
            ?? dynamicCtx.agentDefaultModel
          ) as DefaultModelService | undefined
          currentModel = (modelSvc?.currentSelection?.()?.model ?? '').toLowerCase()
        } catch {
          // 读取模型异常不影响主链路
        }

        const isGptModel = currentModel.includes('gpt') || currentModel.includes('openai')
        const isNonGemini =
          isGptModel ||
          currentModel.includes('claude') ||
          currentModel.includes('anthropic') ||
          currentModel.includes('3p')
        const nonGeminiBadge = isGptModel ? 'GPT-OSS' : 'Claude'

        const groupEntries: Array<{ group: typeof groups[number]; badge: string }> = []
        if (isNonGemini) {
          if (nonGeminiGroup) groupEntries.push({ group: nonGeminiGroup, badge: nonGeminiBadge })
          if (geminiGroup) groupEntries.push({ group: geminiGroup, badge: 'Gemini' })
        } else {
          if (geminiGroup) groupEntries.push({ group: geminiGroup, badge: 'Gemini' })
          if (nonGeminiGroup) groupEntries.push({ group: nonGeminiGroup, badge: nonGeminiBadge })
        }
        for (const g of groups) {
          if (!groupEntries.some(e => e.group === g)) {
            groupEntries.push({ group: g, badge: g.group })
          }
        }

        const totalPages = Math.min(4, groupEntries.length)
        const views: PetCustomNode[] = []
        let activeMinRemaining = 1

        for (let i = 0; i < totalPages; i++) {
          const entry = groupEntries[i]!
          const nextEntry = groupEntries[(i + 1) % totalPages]!
          const hint = totalPages > 1 ? `点击切换至 ${nextEntry.badge} 额度` : ''
          views.push(createPetGroupPage(entry.badge, i, totalPages, entry.group.windows ?? [], hint))

          // 仅以当前激活分组（第 1 页）计算桌宠档位动画百分比
          if (i === 0) {
            for (const win of entry.group.windows ?? []) {
              if (typeof win.remainingFraction === 'number') {
                activeMinRemaining = Math.min(activeMinRemaining, win.remainingFraction)
              }
            }
          }
        }

        // 当前激活分组最告急窗口的已用百分比驱动桌宠档位动画（0 = 未消耗，100 = 耗尽）
        const percent = Math.max(0, Math.min(100, Math.round((1 - activeMinRemaining) * 100)))

        return {
          ok: true,
          provider,
          shape: 'custom',
          data: {
            views,
            percent,
          },
        }
      },
    })

    return () => unregister?.()
  })
}
