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
 * @property {boolean} [enableFilter] - 是否启用记录过滤功能
 * @property {string[]} [blacklist] - 记录黑名单列表
 * @property {string[]} [whitelist] - 记录白名单列表
 * @property {boolean} [enableDisplayFilter] - 是否启用显示过滤功能
 * @property {string[]} [displayBlacklist] - 显示过滤黑名单
 * @property {string[]} [displayWhitelist] - 显示过滤白名单
 */
export interface Config {
  enableImport?: boolean
  enableClear?: boolean
  enableFilter?: boolean
  blacklist?: string[]
  whitelist?: string[]
  enableDisplayFilter?: boolean
  displayBlacklist?: string[]
  displayWhitelist?: string[]
}

/**
 * 插件配置模式
 * 使用 Schema.intersect 组合多个配置块
 */
export const Config = Schema.intersect([
  Schema.object({
    enableImport: Schema.boolean().default(false).description('启用统计数据导入命令'),
    enableClear: Schema.boolean().default(false).description('启用统计数据清除命令'),
    enableFilter: Schema.boolean().default(false).description('启用记录过滤功能'),
    enableDisplayFilter: Schema.boolean().default(false).description('启用显示过滤功能'),
  }).description('基础配置'),
  Schema.union([
    Schema.object({
      enableFilter: Schema.const(true).required(),
      whitelist: Schema.array(Schema.string())
        .description('记录白名单，仅统计这些记录（先于黑名单生效）')
        .default([]),
      blacklist: Schema.array(Schema.string())
        .description('记录黑名单，将不会统计以下命令/用户/群组/平台')
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
      enableDisplayFilter: Schema.const(true).required(),
      displayWhitelist: Schema.array(Schema.string())
        .description('显示白名单，仅展示这些统计记录（先于黑名单生效）')
        .default([]),
      displayBlacklist: Schema.array(Schema.string())
        .description('显示黑名单，将不会默认展示以下命令/用户/群组/平台')
        .default([
          'onebot:12345:67890',
          'qq::12345',
          'sandbox::',
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
    if (!info) return
    if (config.enableFilter) {
      // 优先检查白名单
      if (config.whitelist?.length) {
        if (!utils.matchRuleList(config.whitelist, {
          platform: info.platform,
          guildId: info.guildId,
          userId: info.userId,
          command
        })) {
          return
        }
      }
      // 白名单为空时，检查黑名单
      else if (config.blacklist?.length) {
        if (utils.matchRuleList(config.blacklist, {
          platform: info.platform,
          guildId: info.guildId,
          userId: info.userId,
          command
        })) {
          return
        }
      }
    }
    const commandValue = command === null ? '' : (command || '')
    await database.saveRecord(ctx, { ...info, command: commandValue })
  }

  ctx.on('command/before-execute', ({session, command}) => handleRecord(session, command.name))
  ctx.on('message', (session) => handleRecord(session, null))

  const stat = ctx.command('stat [arg:string]', '查看命令统计')
    .option('user', '-u [user:string] 指定用户统计')
    .option('guild', '-g [guild:string] 指定群组统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .option('all', '-a 显示所有记录')
    .option('page', '-n [page:number] 指定页码', { fallback: 1 })
    .action(async ({options, args}) => {
      const arg = args[0]?.toLowerCase()
      if (arg === 'all') {
        options.all = true
      } else if (arg && /^\d+$/.test(arg)) {
        options.page = parseInt(arg)
      }
      const result = await utils.handleStatQuery(ctx, options, 'command')
      if (typeof result === 'string') return result
      const pageSize = 15
      const processed = await utils.processStatRecords(result.records, 'command', {
        sortBy: 'key',
        disableCommandMerge: options.all,
        displayBlacklist: options.all ? [] : (config.enableDisplayFilter ? config.displayBlacklist : []),
        displayWhitelist: options.all ? [] : (config.enableDisplayFilter ? config.displayWhitelist : []),
        page: options.page || 1,
        pageSize,
        title: result.title,
        skipPaging: options.all
      })

      return processed.title + '\n' + processed.items.join('\n')
    })

  stat.subcommand('.user [arg:string]', '查看发言统计')
    .option('guild', '-g [guild:string] 指定群组统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .option('all', '-a 显示所有记录')
    .option('page', '-n [page:number] 指定页码', { fallback: 1 })
    .action(async ({options, args}) => {
      const arg = args[0]?.toLowerCase()
      if (arg === 'all') {
        options.all = true
      } else if (arg && /^\d+$/.test(arg)) {
        options.page = parseInt(arg)
      }
      const result = await utils.handleStatQuery(ctx, options, 'user')
      if (typeof result === 'string') return result
      const pageSize = 15
      const processed = await utils.processStatRecords(result.records, 'userId', {
        truncateId: true,
        displayBlacklist: options.all ? [] : (config.enableDisplayFilter ? config.displayBlacklist : []),
        displayWhitelist: options.all ? [] : (config.enableDisplayFilter ? config.displayWhitelist : []),
        page: options.page || 1,
        pageSize,
        title: result.title,
        skipPaging: options.all
      })

      return processed.title + '\n' + processed.items.join('\n')
    })

  stat.subcommand('.guild [arg:string]', '查看群组统计')
    .option('user', '-u [user:string] 指定用户统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .option('command', '-c [command:string] 指定命令统计')
    .option('all', '-a 显示所有记录')
    .option('page', '-n [page:number] 指定页码', { fallback: 1 })
    .action(async ({options, args}) => {
      const arg = args[0]?.toLowerCase()
      if (arg === 'all') {
        options.all = true
      } else if (arg && /^\d+$/.test(arg)) {
        options.page = parseInt(arg)
      }
      const result = await utils.handleStatQuery(ctx, options, 'guild')
      if (typeof result === 'string') return result
      const pageSize = 15
      const processed = await utils.processStatRecords(result.records, 'guildId', {
        truncateId: true,
        displayBlacklist: options.all ? [] : (config.enableDisplayFilter ? config.displayBlacklist : []),
        displayWhitelist: options.all ? [] : (config.enableDisplayFilter ? config.displayWhitelist : []),
        page: options.page || 1,
        pageSize,
        title: result.title,
        skipPaging: options.all
      })

      return processed.title + '\n' + processed.items.join('\n')
    })

  stat.subcommand('.list', '查看类型列表', { authority: 3 })
    .option('user', '-u 显示用户列表')
    .option('guild', '-g 显示群组列表')
    .action(async ({ options }) => {
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
        return items.length ? `${title} ——\n${items.join(',')}` : null
      }
      const hasParams = options.user || options.guild
      const parts: (string | null)[] = []
      if (!hasParams) {
        parts.push(formatList('platform', '平台列表'))
        parts.push(formatList('command', '命令列表'))
      }
      if (options.user) parts.push(formatList('userId', '用户列表'))
      if (options.guild) parts.push(formatList('guildId', '群组列表'))
      return parts.filter(Boolean).join('\n')
    })

  if (config.enableClear) {
    stat.subcommand('.clear', '清除统计数据', { authority: 4 })
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
          .map(([_, [label, value]]) => `${label}${value}`)
        return conditions.length
          ? `已删除${conditions.join('、')}的统计记录`
          : '已删除所有统计记录'
      })
  }
  if (config.enableImport) {
    stat.subcommand('.import', '导入统计数据', { authority: 4 })
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
