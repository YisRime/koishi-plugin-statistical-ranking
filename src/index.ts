import { Context, Schema } from 'koishi'
import { database } from './database'
import { utils, StatMap } from './utils'

/**
 * @packageDocumentation
 * 统计与排名插件 - 用于统计和分析用户命令使用情况与活跃度
 */

/**
 * 插件名称及依赖配置
 * @public
 */
export const name = 'statistical-ranking'
export const inject = { required: ['database'] }

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
 * @property {string} platform - 平台标识
 * @property {string} guildId - 群组ID
 * @property {string} userId - 用户ID
 * @property {string} [userName] - 用户昵称
 * @property {string} [command] - 命令名称
 * @property {number} count - 记录次数
 * @property {Date} lastTime - 最后记录时间
 * @property {string} [guildName] - 群组名称
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

interface LegacyCommandRecord {
  name: string
  userId: string
  channelId: string
  platform?: string
  date: number
  hour: number
  count: number
}

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
    const sessionInfo = await utils.getSessionInfo(session)
    await database.saveRecord(ctx, {
      ...sessionInfo,
      command
    })
  }

  ctx.on('command/before-execute', ({session, command}) =>
    handleRecord(session, command.name)
  )

  ctx.on('message', (session) =>
    handleRecord(session, null)
  )

  const stat = ctx.command('stat', '查看命令统计')
    .option('user', '-u [user:string] 指定用户统计')
    .option('guild', '-g [guild:string] 指定群组统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .option('command', '-c [command:string] 指定命令统计')
    .action(async ({options}) => {
      const baseQuery = utils.buildQueryFromOptions({
        user: options.user,
        guild: options.guild,
        platform: options.platform
      })

      const query = {
        ...baseQuery,
        command: options.command ? options.command : { $not: null }
      }

      const records = await ctx.database.get('analytics.stat', query)
      if (!records?.length) return '未找到记录'

      const conditions = utils.formatConditions(options)
      const title = conditions.length
        ? `${conditions.join('、')}的命令统计 ——`
        : '全局命令统计 ——'

      const lines = await utils.processStatRecords(records, 'command', null, 'key', false)
      return title + '\n\n' + lines.join('\n')
    })

  stat.subcommand('.user', '查看发言统计')
    .option('user', '-u [user:string] 指定用户统计')
    .option('guild', '-g [guild:string] 指定群组统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .action(async ({session, options}) => {
      const query = utils.buildQueryFromOptions(options)
      query.command = null

      const records = await ctx.database.get('analytics.stat', query)
      if (!records?.length) return '未找到记录'

      const conditions = utils.formatConditions({ ...options })
      const title = conditions.length
        ? `${conditions.join('、')}的发言统计 ——`
        : '全局发言统计 ——'

      const formatUserStat = async (userId: string, data: { count: number, lastTime: Date }) => {
        const name = await utils.getName(session, userId, 'user')
        return `${name.padEnd(10, ' ')}${data.count.toString().padStart(5)}次 ${utils.formatTimeAgo(data.lastTime)}`
      }

      const lines = await utils.processStatRecords(records, 'userId', formatUserStat, 'count')
      return title + '\n\n' + lines.join('\n')
    })

  stat.subcommand('.list', '查看类型列表', { authority: 3 })
    .action(async ({ session }) => {
      const records = await ctx.database.get('analytics.stat', {})
      if (!records.length) return '未找到记录'

      const platforms = utils.getUniqueKeys(records, 'platform')
      const users = utils.getUniqueKeys(records, 'userId')
      const guilds = utils.getUniqueKeys(records, 'guildId')
      const commands = utils.getUniqueKeys(records, 'command')

      const parts = []

      if (platforms.length) {
        parts.push(`平台列表：\n${platforms.join(',')}`)
      }

      if (users.length) {
        const names = await Promise.all(users.map(id => utils.getName(session, id, 'user')))
        parts.push(`用户列表：\n${names.map((name, i) => `${name} (${users[i].slice(0, 10)})`).join(',')}`) // 对用户ID进行截断
      }

      if (guilds.length) {
        const guildInfos = records.reduce((map, record) => {
          if (record.guildId && record.guildName) {
            map.set(record.guildId, record.guildName)
          }
          return map
        }, new Map<string, string>())

        const names = await Promise.all(guilds.map(async id => {
          const savedName = guildInfos.get(id)
          return savedName || await utils.getName(session, id, 'guild')
        }))
        parts.push(`群组列表：\n${names.map((name, i) => `${name} (${guilds[i].slice(0, 10)})`).join(',')}`) // 对群组ID进行截断
      }

      if (commands.length) {
        parts.push(`命令列表：\n${commands.join(',')}`)
      }

      return parts.join('\n')
    })

  stat.subcommand('.guild', '查看群组统计')
    .option('user', '-u [user:string] 指定用户统计')
    .option('guild', '-g [guild:string] 指定群组统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .option('command', '-c [command:string] 指定命令统计')
    .action(async ({session, options}) => {
      const query = utils.buildQueryFromOptions({
        user: options.user,
        guild: options.guild,
        platform: options.platform,
        command: options.command
      })

      const records = await ctx.database.get('analytics.stat', query)
      if (!records.length) return '未找到记录'

      const conditions = utils.formatConditions(options)
      const title = conditions.length
        ? `${conditions.join('、')}的群组统计 ——`
        : '全局群组统计 ——'

      const guildNameMap = new Map<string, string>()
      for (const record of records) {
        if (record.guildName) {
          guildNameMap.set(record.guildId, record.guildName)
        }
      }
      const needNameIds = Array.from(new Set(
        records.filter(r => !guildNameMap.has(r.guildId))
          .map(r => r.guildId)
      ))
      if (needNameIds.length > 0) {
        const names = await Promise.all(
          needNameIds.map(id => utils.getName(session, id, 'guild'))
        )
        needNameIds.forEach((id, index) => {
          guildNameMap.set(id, names[index])
        })
      }

      const formatGuildStat = async (guildId: string, data: { count: number, lastTime: Date }) => {
        const name = guildNameMap.get(guildId) || guildId.slice(0, 10)
        return `${name.padEnd(10, ' ')}${data.count.toString().padStart(5)}次 ${utils.formatTimeAgo(data.lastTime)}`
      }

      const lines = await utils.processStatRecords(records, 'guildId', formatGuildStat, 'count')
      return title + '\n\n' + lines.join('\n')
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

        if (result === -1) {
          return '已删除所有统计记录'
        }

        const conditions = utils.formatConditions(options)
        return conditions.length
          ? `已删除${conditions.join('、')}的统计记录`
          : '已删除所有统计记录'
      })
  }

  if (config.enableImport) {
    stat.subcommand('.import', '导入统计数据', { authority: 3 })
      .option('force', '-f 覆盖现有数据')
      .action(async ({ session, options }) => {
        try {
          await database.importLegacyData(ctx, session, options.force)
          return '导入完成'
        } catch (e) {
          return `导入失败：${e.message}`
        }
      })
  }
}
