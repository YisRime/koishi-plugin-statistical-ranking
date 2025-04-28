import { Context, Schema, Session, h } from 'koishi'
import { database } from './database'
import { io } from './io'
import { Utils } from './utils'
import { statProcessor } from './stat'
import { Renderer } from './render'
import { Rank } from './rank'

export const name = 'statistical-ranking'
export const inject = { required: ['database'], optional: ['puppeteer', 'cron'] }

export const usage = `
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #4a6ee0;">📌 插件说明</h2>
  <p>📖 <strong>使用文档</strong>：请点击左上角的 <strong>插件主页</strong> 查看插件使用文档</p>
  <p>🔍 <strong>更多插件</strong>：可访问 <a href="https://github.com/YisRime" style="color:#4a6ee0;text-decoration:none;">苡淞的 GitHub</a> 查看本人的所有插件</p>
</div>

<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #e0574a;">❤️ 支持与反馈</h2>
  <p>🌟 喜欢这个插件？请在 <a href="https://github.com/YisRime" style="color:#e0574a;text-decoration:none;">GitHub</a> 上给我一个 Star！</p>
  <p>🐛 遇到问题？请通过 <strong>Issues</strong> 提交反馈，或加入 QQ 群 <a href="https://qm.qq.com/q/PdLMx9Jowq" style="color:#e0574a;text-decoration:none;"><strong>855571375</strong></a> 进行交流</p>
</div>
`

/**
 * 插件配置接口
 * @interface Config
 * @property {boolean} [enableDataTransfer] - 是否启用数据导入导出功能
 * @property {string[]} [displayBlacklist] - 显示过滤黑名单
 * @property {string[]} [displayWhitelist] - 显示过滤白名单
 * @property {boolean} [defaultImageMode] - 是否默认使用图片模式展示
 * @property {boolean} [enableRank] - 是否启用排行榜功能
 * @property {string} [updateInterval] - 排行榜更新频率
 */
export interface Config {
  enableDataTransfer?: boolean
  displayBlacklist?: string[]
  displayWhitelist?: string[]
  defaultImageMode?: boolean
  enableRank?: boolean
  updateInterval?: string
}

/**
 * 插件配置模式
 */
export const Config = Schema.intersect([
  Schema.object({
    defaultImageMode: Schema.boolean().default(false).description('启用图片输出'),
    enableDataTransfer: Schema.boolean().default(true).description('启用导入导出'),
    enableRank: Schema.boolean().default(false).description('启用发言排行')
  }).description('基础配置'),
  Schema.union([
    Schema.object({
      enableRank: Schema.const(true).required(),
      updateInterval: Schema.union([
        Schema.const('hourly').description('每小时'),
        Schema.const('6h').description('每6小时'),
        Schema.const('12h').description('每12小时'),
        Schema.const('daily').description('每天')
      ]).default('daily').description('数据更新频率')
    }),
    Schema.object({})
  ]),
  Schema.object({
    displayWhitelist: Schema.array(Schema.string()).description('白名单（仅展示以下记录）').default([]),
    displayBlacklist: Schema.array(Schema.string()).description('黑名单（不默认展示以下记录）').default(['qq:1234:5678', '.message'])
  }).description('展示配置')
])

/**
 * 数据表声明
 */
declare module 'koishi' {
  interface Tables {
    'analytics.stat': StatRecord
    'analytics.rank': RankRecord
    'analytics.command': LegacyCommandRecord
    binding: BindingRecord
  }
}

/**
 * 排行榜记录数据结构
 * @interface RankRecord
 * @description 存储用户统计数据的排名记录
 * @property {number} id - 排行榜记录的唯一ID（自增主键，导入导出时会自动忽略）
 * @property {number} stat - 统计记录ID，关联到统计数据
 * @property {Date} timestamp - 记录时间戳
 * @property {number} count - 统计项的计数值
 */
export interface RankRecord {
  id: number
  stat: number
  timestamp: Date
  count: number
}

/**
 * 统计记录数据结构
 * @interface StatRecord
 * @description 记录用户在不同平台、群组中的命令使用和消息发送情况
 * @property {number} id - 记录的唯一ID（自增主键，导入导出时会自动忽略）
 * @property {string} platform - 平台标识(如 onebot、telegram 等)
 * @property {string} guildId - 群组/频道 ID，私聊时为 'private'
 * @property {string} userId - 用户在该平台的唯一标识
 * @property {string} [userName] - 用户昵称，可选
 * @property {string} command - 命令名称，普通消息时为 '_message'
 * @property {number} count - 记录次数，用于统计使用频率
 * @property {Date} lastTime - 最后一次记录的时间
 * @property {string} [guildName] - 群组/频道名称，可选
 */
export interface StatRecord {
  id?: number
  platform: string
  guildId: string
  userId: string
  userName?: string
  command: string
  count: number
  lastTime: Date
  guildName?: string
}

/**
 * 历史命令记录结构
 * @interface LegacyCommandRecord
 * @description 用于兼容旧版统计数据的结构
 */
interface LegacyCommandRecord {
  name: string
  userId: string
  channelId: string
  platform?: string
  date: number
  hour: number
  count: number
}

/**
 * 用户绑定记录结构
 * @interface BindingRecord
 * @description 存储用户跨平台账号绑定关系
 * @property {string} pid - 平台用户 ID
 * @property {string} platform - 平台标识
 * @property {number} aid - 关联账号 ID
 * @property {number} bid - 绑定记录 ID
 */
interface BindingRecord {
  pid: string
  platform: string
  aid: number
  bid: number
}

/**
 * 排行榜更新频率到cron表达式的映射
 */
const rankUpdateCrons = {
  'hourly': '0 * * * *',
  '6h': '0 */6 * * *',
  '12h': '0 */12 * * *',
  'daily': '0 0 * * *'
}

/**
 * 插件主函数
 * @public
 * @param ctx - Koishi应用上下文
 * @param config - 插件配置对象
 */
export async function apply(ctx: Context, config: Config = {}) {
  config = { enableDataTransfer: true, defaultImageMode: false, displayWhitelist: [],
    displayBlacklist: [], enableRank: true, updateInterval: 'daily', ...config }

  database.initialize(ctx)

  let rank: Rank | null = null
  if (config.enableRank && ctx.cron) {
    database.initializeRankTable(ctx)
    rank = new Rank(ctx, { updateInterval: config.updateInterval, defaultImageMode: config.defaultImageMode })
    ctx.cron(rankUpdateCrons[config.updateInterval] || rankUpdateCrons.daily,
      () => rank.generateRankSnapshot())
  }

  /**
   * 处理消息和命令记录
   * @param {Session} session - 会话对象
   * @param {string} [command] - 命令名称，为空时表示普通消息
   * @returns {Promise<void>}
   */
  const handleRecord = async (session: any, command?: string) => {
    const info = await Utils.getSessionInfo(session)
    if (!info) return
    await database.saveRecord(ctx, { ...info, command: command || '_message' })
  }

  ctx.on('command/before-execute', ({session, command}) => handleRecord(session, command.name))
  ctx.on('message', (session) => handleRecord(session, null))

  /**
   * 尝试渲染图片并发送
   * @param {Session} session - 会话对象
   * @param {Function} renderFn - 渲染函数，接收Renderer实例作为参数，返回Promise<Buffer|Buffer[]>
   * @returns {Promise<boolean>} 渲染是否成功
   * @description 使用puppeteer渲染图片并发送，如果失败则返回false
   */
  async function tryRenderImage(session: Session<never, never>, renderFn: (renderer: Renderer) => Promise<Buffer | Buffer[]>): Promise<boolean> {
    if (!ctx.puppeteer) return false
    try {
      const renderer = new Renderer(ctx)
      const result = await renderFn(renderer)
      const buffers = Array.isArray(result) ? result : [result]
      await session.send(buffers.map(buffer => h.image(buffer, 'image/png')).join(''))
      return true
    } catch (e) {
      ctx.logger.error('图片渲染失败', e)
      return false
    }
  }

  const stat = ctx.command('stat [arg:string]', '查看统计信息')
    .option('visual', '-v 切换可视化模式')
    .option('sort', '-s [method:string] 排序方式', { fallback: 'count' })
    .option('user', '-u [userId:string] 指定用户', { authority: 2 })
    .action(async ({ session, args, options }) => {
      const currentUser = await Utils.getSessionInfo(session)
      const arg = args[0]?.toLowerCase()
      const page = arg && /^\d+$/.test(arg) ? parseInt(arg) : 1
      const showAll = arg === 'all'
      const targetUserId = options.user || currentUser.userId
      const targetPlatform = options.user ? undefined : currentUser.platform
      const [commandResult, messageResult] = await Promise.all([
        statProcessor.handleStatQuery(ctx, { user: targetUserId, platform: targetPlatform }, 'command'),
        statProcessor.handleStatQuery(ctx, {
          user: targetUserId, platform: targetPlatform, command: '_message'
        }, 'guild')
      ])
      let totalMessages = 0
      if (typeof messageResult !== 'string') {
        totalMessages = messageResult.records.reduce((sum, record) => sum + record.count, 0)
      }
      const allItems = []
      const sortBy = options.sort === 'time' ? 'time' : (options.sort === 'key' ? 'key' : 'count')
      if (typeof commandResult !== 'string' && commandResult.records.length > 0) {
        const processedCommands = await statProcessor.processStatRecords(commandResult.records, 'command', {
          sortBy, disableCommandMerge: false, skipPaging: true, title: '命令统计'
        })
        allItems.push(...processedCommands.items.map(item => ({ type: 'command', content: item })))
      }
      if (typeof messageResult !== 'string' && messageResult.records.length > 0) {
        const processedGroups = await statProcessor.processStatRecords(messageResult.records, 'guildId', {
          sortBy, truncateId: true, skipPaging: true, title: '群组统计'
        })
        allItems.push(...processedGroups.items.map(item => ({ type: 'guild', content: item })))
      }
      const pageSize = 8
      const totalPages = Math.ceil(allItems.length / pageSize) || 1
      const validPage = Math.min(Math.max(1, page), totalPages)
      const startIdx = showAll ? 0 : (validPage - 1) * pageSize
      const endIdx = showAll ? allItems.length : Math.min(startIdx + pageSize, allItems.length)
      const pagedItems = allItems.slice(startIdx, endIdx)
      let displayName = currentUser.userName || currentUser.userId
      if (options.user) {
        const userRecord = typeof messageResult !== 'string' && messageResult.records.find(r => r.userId === options.user && r.userName)
          || typeof commandResult !== 'string' && commandResult.records.find(r => r.userId === options.user && r.userName)
        displayName = userRecord?.userName || options.user
      }
      const pageInfo = (showAll || totalPages <= 1) ? '' : `（第${validPage}/${totalPages}页）`
      const title = `${displayName}的统计（共${totalMessages}条）${pageInfo} ——`
      const items = pagedItems.map(item => item.content)
      const useImageMode = options.visual ? !config.defaultImageMode : config.defaultImageMode
      if (useImageMode) {
        const renderSuccess = await tryRenderImage(session, async (renderer) => {
          const datasets = []
          if (typeof commandResult !== 'string' && commandResult.records.length > 0) {
            datasets.push({
              records: commandResult.records, title: '命令统计', key: 'command',
              options: { sortBy, limit: 15, truncateId: false }
            })
          }
          if (typeof messageResult !== 'string' && messageResult.records.length > 0) {
            datasets.push({
              records: messageResult.records, title: '发言统计', key: 'guildId',
              options: { sortBy, limit: 15, truncateId: true }
            })
          }
          return await renderer.generateCombinedStatImage(datasets, `${displayName}的统计`)
        })
        if (renderSuccess) return
      }
      return title + '\n' + items.join('\n')
    })

  stat.subcommand('.command [arg:string]', '查看命令统计')
    .option('user', '-u [user:string] 指定用户统计')
    .option('guild', '-g [guild:string] 指定群组统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .option('visual', '-v 切换可视化模式')
    .option('all', '-a 显示全局统计')
    .option('sort', '-s [method:string] 排序方式', { fallback: 'count' })
    .action(async ({options, args, session}) => {
      const arg = args[0]?.toLowerCase()
      const page = arg && /^\d+$/.test(arg) ? parseInt(arg) : 1
      const showAll = arg === 'all'
      if (!options.guild && !options.all && session.guildId) options.guild = session.guildId
      if (!session.guildId && !options.guild && !options.user && !options.platform) options.all = true
      const result = await statProcessor.handleStatQuery(ctx, options, 'command')
      if (typeof result === 'string') return result
      const sortBy = options.sort === 'time' ? 'time' : (options.sort === 'key' ? 'key' : 'count')
      const useImageMode = options.visual ? !config.defaultImageMode : config.defaultImageMode
      if (useImageMode) {
        const renderSuccess = await tryRenderImage(session, async (renderer) => {
          return await renderer.generateStatImage(result.records, 'command', result.title.replace(' ——', ''), {
            sortBy, disableCommandMerge: showAll,
            displayBlacklist: showAll ? [] : config.displayBlacklist,
            displayWhitelist: showAll ? [] : config.displayWhitelist, limit: 15
          })
        })
        if (renderSuccess) return
      }
      const processed = await statProcessor.processStatRecords(result.records, 'command', {
        sortBy, disableCommandMerge: showAll,
        displayBlacklist: showAll ? [] : config.displayBlacklist,
        displayWhitelist: showAll ? [] : config.displayWhitelist,
        page, pageSize: 15, title: result.title, skipPaging: showAll
      })
      return processed.title + '\n' + processed.items.join('\n')
    })

  stat.subcommand('.user [arg:string]', '查看发言统计')
    .option('guild', '-g [guild:string] 指定群组统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .option('visual', '-v 切换可视化模式')
    .option('all', '-a 显示全局统计')
    .option('sort', '-s [method:string] 排序方式', { fallback: 'count' })
    .action(async ({options, args, session}) => {
      const arg = args[0]?.toLowerCase()
      const page = arg && /^\d+$/.test(arg) ? parseInt(arg) : 1
      const showAll = arg === 'all'
      if (!options.guild && !options.all && session.guildId) options.guild = session.guildId
      if (!session.guildId && !options.guild && !options.platform) options.all = true
      const result = await statProcessor.handleStatQuery(ctx, options, 'user')
      if (typeof result === 'string') return result
      const sortBy = options.sort === 'time' ? 'time' : (options.sort === 'key' ? 'key' : 'count')
      const useImageMode = options.visual ? !config.defaultImageMode : config.defaultImageMode
      if (useImageMode) {
        const renderSuccess = await tryRenderImage(session, async (renderer) => {
          return await renderer.generateStatImage(result.records, 'userId', result.title.replace(' ——', ''), {
            sortBy, truncateId: true,
            displayBlacklist: showAll ? [] : config.displayBlacklist,
            displayWhitelist: showAll ? [] : config.displayWhitelist, limit: 15
          })
        })
        if (renderSuccess) return
      }
      const processed = await statProcessor.processStatRecords(result.records, 'userId', {
        sortBy, truncateId: true,
        displayBlacklist: showAll ? [] : config.displayBlacklist,
        displayWhitelist: showAll ? [] : config.displayWhitelist,
        page, pageSize: 15, title: result.title, skipPaging: showAll
      })
      return processed.title + '\n' + processed.items.join('\n')
    })

  stat.subcommand('.guild [arg:string]', '查看群组统计', { authority: 2 })
    .option('user', '-u [user:string] 指定用户统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .option('command', '-c [command:string] 指定命令统计')
    .option('visual', '-v 切换可视化模式')
    .option('sort', '-s [method:string] 排序方式', { fallback: 'count' })
    .action(async ({options, args, session}) => {
      const arg = args[0]?.toLowerCase()
      const page = arg && /^\d+$/.test(arg) ? parseInt(arg) : 1
      const showAll = arg === 'all'
      const result = await statProcessor.handleStatQuery(ctx, options, 'guild')
      if (typeof result === 'string') return result
      const sortBy = options.sort === 'time' ? 'time' : (options.sort === 'key' ? 'key' : 'count')
      const useImageMode = options.visual ? !config.defaultImageMode : config.defaultImageMode
      if (useImageMode) {
        const renderSuccess = await tryRenderImage(session, async (renderer) => {
          return await renderer.generateStatImage(result.records, 'guildId', result.title.replace(' ——', ''), {
            sortBy, truncateId: true,
            displayBlacklist: showAll ? [] : config.displayBlacklist,
            displayWhitelist: showAll ? [] : config.displayWhitelist, limit: 15
          })
        })
        if (renderSuccess) return
      }
      const processed = await statProcessor.processStatRecords(result.records, 'guildId', {
        sortBy, truncateId: true,
        displayBlacklist: showAll ? [] : config.displayBlacklist,
        displayWhitelist: showAll ? [] : config.displayWhitelist,
        page, pageSize: 15, title: result.title, skipPaging: showAll
      })
      return processed.title + '\n' + processed.items.join('\n')
    })

  statProcessor.registerListCommand(ctx, stat)
  database.registerClearCommand(ctx, stat)

  if (config.enableRank && rank) rank.registerRankCommands(stat)
  if (config.enableDataTransfer) io.registerCommands(ctx, stat, rank)
}