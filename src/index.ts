import { Context, Schema } from 'koishi'
import { database } from './database'
import { utils } from './utils'

/**
 * @packageDocumentation
 * 统计与排名插件 - 用于统计和分析用户命令使用情况与活跃度
 */

/**
 * 插件名称及依赖配置
 * @public
 */
export const name = 'statistical-ranking'
export const inject = ['database']

/**
 * 插件配置接口
 * @interface Config
 * @property {boolean} [enableImport] - 是否启用数据导入功能
 * @property {boolean} [enableClear] - 是否启用数据清除功能
 * @property {boolean} [enableBlacklist] - 是否启用黑名单功能
 * @property {boolean} [enableWhitelist] - 是否启用白名单功能
 * @property {string[]} [blacklist] - 黑名单列表
 * @property {string[]} [whitelist] - 白名单列表
 */
export interface Config {
  enableImport?: boolean
  enableClear?: boolean
  enableBlacklist?: boolean
  enableWhitelist?: boolean
  blacklist?: string[]
  whitelist?: string[]
}

/**
 * 插件配置模式
 * 使用 Schema.intersect 组合多个配置块
 */
export const Config = Schema.intersect([
  Schema.object({
    enableImport: Schema.boolean().default(false).description('启用统计数据导入命令'),
    enableClear: Schema.boolean().default(false).description('启用统计数据清除命令'),
    enableBlacklist: Schema.boolean().default(false).description('启用黑名单'),
    enableWhitelist: Schema.boolean().default(false).description('启用白名单'),
  }).description('基础配置'),
  Schema.union([
    Schema.object({
      enableBlacklist: Schema.const(true).required(),
      blacklist: Schema.array(Schema.string())
        .description('黑名单列表')
        .default([
          'onebot:12345:67890',
          'qq::12345',
          'sandbox::',
          '.help',
        ]),
    }),
    Schema.object({}),
  ]),
  Schema.union([
    Schema.object({
      enableWhitelist: Schema.const(true).required(),
      whitelist: Schema.array(Schema.string())
        .description('白名单列表')
        .default([
          'onebot:12345:67890',
          'qq::12345',
          'telegram::',
          '.help',
        ]),
    }),
    Schema.object({}),
  ]),
])

/**
 * Koishi 数据表声明
 */
declare module 'koishi' {
  interface Tables {
    'analytics.stat': StatRecord
    'analytics.command': LegacyCommandRecord
    binding: BindingRecord
  }
}

/**
 * 统计记录数据结构
 * @interface StatRecord
 * @description 记录用户在不同平台、群组中的命令使用和消息发送情况
 * @property {string} platform - 平台标识(如 onebot、telegram 等)
 * @property {string} guildId - 群组/频道 ID，私聊时为 'private'
 * @property {string} userId - 用户在该平台的唯一标识
 * @property {string} [userName] - 用户昵称，可选
 * @property {string} [command] - 命令名称，为 null 时表示普通消息
 * @property {number} count - 记录次数，用于统计使用频率
 * @property {Date} lastTime - 最后一次记录的时间
 * @property {string} [guildName] - 群组/频道名称，可选
 */
export interface StatRecord {
  platform: string
  guildId: string
  userId: string
  userName?: string
  command?: string
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
 * 插件主函数
 * @public
 *
 * 初始化插件功能：
 * - 设置数据库结构
 * - 注册事件监听器
 * - 注册指令
 *
 * @param ctx - Koishi应用上下文
 * @param config - 插件配置对象
 */
export async function apply(ctx: Context, config: Config) {
  database.initialize(ctx)

  const handleRecord = async (session: any, command?: string) => {
    const info = await utils.getSessionInfo(session)
    info && await database.saveRecord(ctx, { ...info, command })
  }

  ctx.on('command/before-execute', ({session, command}) => handleRecord(session, command.name))
  ctx.on('message', (session) => handleRecord(session, null))

  const stat = ctx.command('stat', '查看命令统计')
    .option('user', '-u [user:string] 指定用户统计')
    .option('guild', '-g [guild:string] 指定群组统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .option('command', '-c [command:string] 指定命令统计')
    .action(async ({options}) => {
      const result = await utils.handleStatQuery(ctx, options, 'command')
      if (typeof result === 'string') return result
      const lines = await utils.processStatRecords(result.records, 'command', { sortBy: 'key' })
      return result.title + '\n\n' + lines.join('\n')
    })

  stat.subcommand('.user', '查看发言统计')
    .option('user', '-u [user:string] 指定用户统计')
    .option('guild', '-g [guild:string] 指定群组统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .action(async ({options}) => {
      const result = await utils.handleStatQuery(ctx, options, 'user')
      if (typeof result === 'string') return result
      const lines = await utils.processStatRecords(result.records, 'userId', { truncateId: true })
      return result.title + '\n\n' + lines.join('\n')
    })

  stat.subcommand('.guild', '查看群组统计')
    .option('user', '-u [user:string] 指定用户统计')
    .option('guild', '-g [guild:string] 指定群组统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .option('command', '-c [command:string] 指定命令统计')
    .action(async ({options}) => {
      const result = await utils.handleStatQuery(ctx, options, 'guild')
      if (typeof result === 'string') return result
      const lines = await utils.processStatRecords(result.records, 'guildId', { truncateId: true })
      return result.title + '\n\n' + lines.join('\n')
    })

  stat.subcommand('.list', '查看类型列表', { authority: 3 })
    .action(async () => {
      const records = await ctx.database.get('analytics.stat', {})
      if (!records?.length) return '未找到记录'

      const formatList = (key: keyof StatRecord, title: string) => {
        const itemMap = new Map<string, string>()

        records.forEach(record => {
          const id = record[key] as string
          if (!id) return

          if (key === 'userId' && record.userName) {
            itemMap.set(id, `${record.userName} (${id})`)
          } else if (key === 'guildId' && record.guildName) {
            itemMap.set(id, `${record.guildName} (${id})`)
          } else {
            itemMap.set(id, id)
          }
        })

        const items = Array.from(itemMap.values())
        return items.length ? `${title}：\n${items.join(', ')}` : null
      }

      const parts = [
        formatList('platform', '平台列表'),
        formatList('userId', '用户列表'),
        formatList('guildId', '群组列表'),
        formatList('command', '命令列表')
      ]

      return parts.filter(Boolean).join('\n')
    })

  if (config.enableClear) {
    stat.subcommand('.clear', '清除统计数据', { authority: 3 })
      .option('user', '-u [user:string] 指定用户')
      .option('platform', '-p [platform:string] 指定平台')
      .option('guild', '-g [guild:string] 指定群组')
      .option('command', '-c [command:string] 指定命令')
      .action(async ({ options }) => {
        const result = await database.clearStats(ctx, {
          userId: options.user,
          platform: options.platform,
          guildId: options.guild,
          command: options.command
        })

        if (result === -1) return '已删除所有统计记录'

        const conditions = Object.entries({
          user: ['用户', options.user],
          guild: ['群组', options.guild],
          platform: ['平台', options.platform],
          command: ['命令', options.command]
        })
          .filter(([_, [__, value]]) => value)
          .map(([_, [label, value]]) => `${label} ${value}`)

        return conditions.length
          ? `已删除${conditions.join('、')}的统计记录`
          : '已删除所有统计记录'
      })
  }

  if (config.enableImport) {
    stat.subcommand('.import', '导入统计数据', { authority: 3 })
      .option('force', '-f 覆盖现有数据')
      .action(async ({ options }) => {
        try {
          await database.importLegacyData(ctx, options.force)
          return '导入完成'
        } catch (e) {
          return `导入失败：${e.message}`
        }
      })
  }
}
