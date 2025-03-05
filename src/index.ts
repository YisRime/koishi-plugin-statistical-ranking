import { Context, Schema } from 'koishi'

/**
 * 插件名称及依赖配置
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
 * @property {'command' | 'message'} type - 记录类型
 * @property {string} platform - 平台标识
 * @property {string} channelId - 频道ID
 * @property {string} userId - 用户ID
 * @property {string} [userNickname] - 用户昵称
 * @property {string} [command] - 命令名称
 * @property {number} count - 记录次数
 * @property {Date} lastTime - 最后记录时间
 * @property {string} [channelName] - 群组名称
 */
interface StatRecord {
  type: 'command' | 'message'
  platform: string
  channelId: string
  userId: string
  userNickname?: string
  command?: string
  count: number
  lastTime: Date
  channelName?: string
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

// 工具函数集合
const utils = {
  /**
   * 获取用户或群组名称
   * @param session - Koishi会话对象
   * @param id - 目标ID
   * @param type - 目标类型：'user'用户或'guild'群组
   * @returns 名称，获取失败则返回原ID
   * @throws 不会抛出异常，失败时返回原ID
   */
  async getName(session: any, id: string, type: 'user' | 'guild'): Promise<string> {
    try {
      if (type === 'user') {
        const info = await session.bot.getGuildMember?.(session.channelId, id)
        return info?.nickname || info?.username || id
      } else {
        const guilds = await session.bot.getGuildList()
        const guild = (Array.isArray(guilds) ? guilds : [guilds])
          .find(g => g.id === id)
        return guild?.name || id
      }
    } catch {
      return id
    }
  },

  /**
   * 将时间转换为"多久之前"的格式
   * @param date 目标时间
   * @returns 格式化后的字符串
   */
  formatTimeAgo(date: Date): string {
    if (isNaN(date.getTime())) {
      return '未知时间'.padStart(9)
    }

    const now = Date.now()
    if (date.getTime() > now) {
      date = new Date()
    }

    const diff = Math.max(0, now - date.getTime())
    if (diff < 300000) return '一会前'.padStart(9)

    const units = [
      { div: 31536000000, unit: '年' },
      { div: 2592000000, unit: '月' },
      { div: 86400000, unit: '天' },
      { div: 3600000, unit: '小时' },
      { div: 60000, unit: '分钟' }
    ]

    const parts = []
    let remaining = diff

    for (const { div, unit } of units) {
      const val = Math.floor(remaining / div)
      if (val > 0) {
        parts.push(`${val}${unit}`)
        remaining %= div
        if (parts.length === 2) break
      }
    }

    const timeText = parts.length ? parts.join('') + '前' : '一会前'
    return timeText.padStart(9)
  },

  /**
   * 将查询选项转换为条件文本数组
   * @param options 查询选项
   * @returns 条件文本数组
   */
  formatConditions(options: {
    type?: string
    user?: string
    group?: string
    platform?: string
    command?: string
  }): string[] {
    const conditions = []
    if (options.type) conditions.push(options.type === 'command' ? '命令' : '消息')
    if (options.user) conditions.push(`用户 ${options.user}`)
    if (options.group) conditions.push(`群组 ${options.group}`)
    if (options.platform) conditions.push(`平台 ${options.platform}`)
    if (options.command) conditions.push(`命令 ${options.command}`)
    return conditions
  },

  /**
   * 将查询选项转换为数据库查询条件
   * @param options 查询选项
   * @returns 数据库查询对象
   */
  buildQueryFromOptions(options: {
    type?: 'command' | 'message'
    user?: string
    group?: string
    platform?: string
    command?: string
  }) {
    const query: any = { type: options.type || 'command' }
    if (options.user) query.userId = options.user
    if (options.group) query.channelId = options.group
    if (options.platform) query.platform = options.platform
    if (options.command) query.command = options.command
    return query
  },

  /**
   * 处理统计记录，聚合并格式化结果
   * @param records 统计记录数组
   * @param aggregateKey 聚合键名
   * @param formatFn 可选的格式化函数
   * @param sortBy 排序方式：'count' 按次数或 'key' 按键名
   * @returns 格式化后的结果数组
   */
  async processStatRecords(
    records: StatRecord[],
    aggregateKey: string,
    formatFn?: (key: string, data: { count: number, lastTime: Date }) => Promise<string>,
    sortBy: 'count' | 'key' = 'count'
  ) {
    const stats = records.reduce((map, record) => {
      const key = aggregateKey === 'command' ? record.command?.split('.')[0] || '' : record[aggregateKey]
      const curr = map.get(key) || { count: 0, lastTime: record.lastTime }
      curr.count += record.count
      if (record.lastTime > curr.lastTime) curr.lastTime = record.lastTime
      map.set(key, curr)
      return map
    }, new Map())

    const sortedEntries = Array.from(stats.entries())
      .sort((a, b) => sortBy === 'count'
        ? b[1].count - a[1].count
        : a[0].localeCompare(b[0]))

    if (formatFn) {
      return Promise.all(sortedEntries.map(([key, data]) => formatFn(key, data)))
    }

    return sortedEntries.map(([key, {count, lastTime}]) =>
      `${key.padEnd(10, ' ')}${count.toString().padStart(5)}次 ${utils.formatTimeAgo(lastTime)}`)
  },

  /**
   * 检查目标是否匹配规则
   * @param rule 规则字符串 platform:group:user
   * @param target 目标对象
   * @returns 是否匹配
   */
  matchRule(rule: string, target: { platform: string, channelId: string, userId: string }): boolean {
    const parts = rule.split(':')
    const [rulePlatform = '', ruleGroup = '', ruleUser = ''] = parts

    // 优先检查用户
    if (ruleUser && target.userId === ruleUser) return true

    // 检查群组
    if (ruleGroup && target.channelId === ruleGroup) return true

    // 最后检查平台
    if (rulePlatform && target.platform === rulePlatform) return true

    return false
  },

  /**
   * 检查目标是否在列表中匹配
   * @param list 规则列表
   * @param target 目标对象
   * @returns 是否匹配
   */
  matchRuleList(list: string[], target: { platform: string, channelId: string, userId: string }): boolean {
    return list.some(rule => utils.matchRule(rule, target))
  },

  /**
   * 获取统计数据中的唯一键列表
   * @param records 统计记录数组
   * @param key 要提取的键名
   * @returns 唯一值数组
   */
  getUniqueKeys(records: StatRecord[], key: 'platform' | 'channelId' | 'userId' | 'command'): string[] {
    return Array.from(new Set(records.map(r => r[key]))).filter(Boolean).sort()
  }
}

/**
 * 数据库操作工具集合
 * 包含数据表初始化、记录保存、数据导入和清除等功能
 */
const database = {
  /**
   * 初始化数据库模型
   * @param ctx Koishi上下文
   */
  initialize(ctx: Context) {
    ctx.model.extend('analytics.stat', {
      platform: 'string',
      channelId: 'string',
      channelName: 'string',
      userId: 'string',
      userNickname: 'string',
      type: 'string',
      command: 'string',
      count: 'unsigned',
      lastTime: 'timestamp',
    }, {
      primary: ['type', 'platform', 'channelId', 'userId', 'command'],
    })
  },

  /**
   * 保存统计记录
   * @param ctx Koishi上下文
   * @param data 记录数据
   */
  async saveRecord(ctx: Context, data: Partial<StatRecord>) {
    if (!data.type || !data.platform || !data.channelId || !data.userId) {
      ctx.logger.warn('saveRecord: missing required fields', data)
      return
    }

    const config = ctx.config.statistical_ranking || {}
    const target = {
      platform: data.platform,
      channelId: data.channelId,
      userId: data.userId
    }

    // 检查黑名单
    if (config?.enableBlacklist && config?.blacklist?.length && utils.matchRuleList(config.blacklist, target)) {
      return
    }

    // 检查白名单
    if (config?.enableWhitelist && config?.whitelist?.length && !utils.matchRuleList(config.whitelist, target)) {
      return
    }

    const query = {
      type: data.type,
      platform: data.platform,
      channelId: data.channelId,
      userId: data.userId,
      command: data.type === 'command' ? data.command || '' : '',
    }

    try {
      let userNickname = ''
      let channelName = ''
      try {
        const bot = ctx.bots.find(bot => bot.platform === data.platform)
        if (bot) {
          // 获取用户昵称
          const info = await bot.getGuildMember?.(data.channelId, data.userId)
          userNickname = info?.nick || info?.name || ''

          // 获取群组名称
          const guild = await bot.getChannel?.(data.channelId)
          channelName = guild?.name || ''
        }
      } catch (e) {
        ctx.logger.warn('Failed to get user/channel info:', e)
      }

      const existing = await ctx.database.get('analytics.stat', query)
      if (existing.length) {
        await ctx.database.set('analytics.stat', query, {
          count: existing[0].count + 1,
          lastTime: new Date(),
          userNickname: userNickname || existing[0].userNickname,
          channelName: channelName || existing[0].channelName,
        })
      } else {
        await ctx.database.create('analytics.stat', {
          ...query,
          userNickname,
          channelName,
          count: 1,
          lastTime: new Date(),
        })
      }
    } catch (e) {
      ctx.logger.error('Failed to save stat record:', e)
    }
  },

  /**
   * 导入历史数据
   * @param ctx Koishi上下文
   * @param session 会话对象
   * @param overwrite 是否覆盖现有数据
   */
  async importLegacyData(ctx: Context, session?: any, overwrite = false) {
    const hasLegacyTable = Object.keys(ctx.database.tables).includes('analytics.command')
    if (!hasLegacyTable) {
      throw new Error('未找到历史数据')
    }

    const legacyCommands = await ctx.database.get('analytics.command', {})
    session.send(`发现 ${legacyCommands.length} 条历史命令记录`)

    if (overwrite) {
      await ctx.database.remove('analytics.stat', { type: 'command' })
    }

    const bindings = await ctx.database.get('binding', {})
    const userIdMap = new Map<string, string>()
    for (const binding of bindings) {
      const key = `${binding.platform}:${binding.aid}`
      if (binding.pid) userIdMap.set(key, binding.pid)
    }

    let importedCount = 0

    for (const cmd of legacyCommands) {
      const platform = cmd.platform || ''
      const key = `${platform}:${cmd.userId}`
      const realUserId = userIdMap.get(key) || cmd.userId
      const command = cmd.name || ''

      const query = {
        type: 'command' as const,
        platform,
        channelId: cmd.channelId,
        userId: realUserId,
        command,
      }

      try {
        if (!overwrite) {
          const existing = await ctx.database.get('analytics.stat', query)
          if (existing.length) {
            const timestamp = cmd.date * 86400000 + cmd.hour * 3600000
            const validTime = new Date(timestamp)
            const now = Date.now()
            const importTime = isNaN(validTime.getTime()) || validTime.getTime() > now
              ? new Date()
              : validTime

            await ctx.database.set('analytics.stat', query, {
              count: existing[0].count + (cmd.count || 1),
              lastTime: new Date(Math.max(
                existing[0].lastTime.getTime(),
                importTime.getTime()
              ))
            })
            importedCount++
            continue
          }
        }

        const timestamp = cmd.date * 86400000 + cmd.hour * 3600000
        const validTime = new Date(timestamp)
        const now = Date.now()
        const lastTime = isNaN(validTime.getTime()) || validTime.getTime() > now
          ? new Date()
          : validTime

        await ctx.database.create('analytics.stat', {
          ...query,
          count: cmd.count || 1,
          lastTime
        })
        importedCount++
      } catch (e) {
        ctx.logger.error('Failed to import record:', e, query)
      }

    }
  },

  /**
   * 清除统计数据
   * @param ctx Koishi上下文
   * @param options 清除选项
   * @returns 清除的记录数量
   */
  async clearStats(ctx: Context, options: {
    type?: 'command' | 'message'
    userId?: string
    platform?: string
    channelId?: string
    command?: string
  }) {
    const query: any = {}
    for (const [key, value] of Object.entries(options)) {
      if (value) query[key] = value
    }
    const result = await ctx.database.remove('analytics.stat', query)
    return Number(result ?? 0)
  }
}

/**
 * 插件主函数
 * 初始化数据库、注册事件监听器和指令
 * @param ctx - Koishi应用上下文
 * @param config - 插件配置对象
 */
export async function apply(ctx: Context, config: Config) {
  database.initialize(ctx)

  ctx.on('command/before-execute', ({session, command}) =>
    database.saveRecord(ctx, {
      type: 'command',
      platform: session.platform,
      channelId: session.channelId,
      userId: session.userId,
      command: command.name
    }))

  ctx.on('message', (session) =>
    database.saveRecord(ctx, {
      type: 'message',
      platform: session.platform,
      channelId: session.channelId,
      userId: session.userId
    }))

  const stat = ctx.command('stat', '查看命令统计')
    .option('user', '-u [user:string] 指定用户统计')
    .option('group', '-g [group:string] 指定群组统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .option('command', '-c [command:string] 指定命令统计')
    .action(async ({options}) => {
      const query = utils.buildQueryFromOptions({ ...options, type: 'command' })
      const records = await ctx.database.get('analytics.stat', query)
      if (!records.length) return '未找到相关记录'

      const conditions = utils.formatConditions(options)
      const title = conditions.length
        ? `${conditions.join(' ')} 命令统计 ——`
        : '全局命令统计 ——'

      const lines = await utils.processStatRecords(records, 'command', null, 'key')
      return title + '\n\n' + lines.join('\n')
    })

  stat.subcommand('.user', '查看发言统计')
    .option('user', '-u [user:string] 指定用户统计')
    .option('group', '-g [group:string] 指定群组统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .action(async ({session, options}) => {
      const query = utils.buildQueryFromOptions({ ...options, type: 'message' })
      const records = await ctx.database.get('analytics.stat', query)
      if (!records.length) return '未找到相关记录'

      const conditions = utils.formatConditions(options)
      const title = conditions.length
        ? `${conditions.join(' ')} 发言统计 ——`
        : '全局发言统计 ——'

      const formatUserStat = async (userId: string, data: { count: number, lastTime: Date }) => {
        const record = records.find(r => r.userId === userId)
        if (!record) return `${userId.padEnd(10, ' ')}${data.count.toString().padStart(5)}次 ${utils.formatTimeAgo(data.lastTime)}`

        const name = record.userNickname || await utils.getName(session, userId, 'user')
        return `${name.padEnd(10, ' ')}${data.count.toString().padStart(5)}次 ${utils.formatTimeAgo(data.lastTime)}`
      }

      const lines = await utils.processStatRecords(records, 'userId', formatUserStat, 'key')
      return title + '\n\n' + lines.join('\n')
    })

  stat.subcommand('.list', '查看统计列表')
    .action(async ({ session }) => {
      const records = await ctx.database.get('analytics.stat', {})
      if (!records.length) return '未找到任何记录'

      const platforms = utils.getUniqueKeys(records, 'platform')
      const users = utils.getUniqueKeys(records, 'userId')
      const groups = utils.getUniqueKeys(records, 'channelId')
      const commands = utils.getUniqueKeys(records, 'command')

      const parts = []

      if (platforms.length) {
        parts.push(`平台列表：\n${platforms.join(',')}`)
      }

      if (users.length) {
        const names = await Promise.all(users.map(id => utils.getName(session, id, 'user')))
        parts.push(`用户列表：\n${names.map((name, i) => `${name} (${users[i]})`).join(',')}`)
      }

      if (groups.length) {
        const groupInfos = records.reduce((map, record) => {
          if (record.channelId && record.channelName) {
            map.set(record.channelId, record.channelName)
          }
          return map
        }, new Map<string, string>())

        const names = await Promise.all(groups.map(async id => {
          const savedName = groupInfos.get(id)
          return savedName || await utils.getName(session, id, 'guild')
        }))
        parts.push(`群组列表：\n${names.map((name, i) => `${name} (${groups[i]})`).join(',')}`)
      }

      if (commands.length) {
        parts.push(`命令列表：\n${commands.join(',')}`)
      }

      return parts.join('\n')
    })

  if (config.enableClear) {
    stat.subcommand('.clear', '清除统计数据', { authority: 3 })
      .option('type', '-t <type:string> 指定清除类型')
      .option('user', '-u [user:string] 指定用户')
      .option('platform', '-p [platform:string] 指定平台')
      .option('group', '-g [group:string] 指定群组')
      .option('command', '-c [command:string] 指定命令')
      .action(async ({ options }) => {
        const type = options.type as 'command' | 'message'
        if (type && !['command', 'message'].includes(type)) {
          return '无效类型'
        }

        await database.clearStats(ctx, {
          type,
          userId: options.user,
          platform: options.platform,
          channelId: options.group,
          command: options.command
        })

        const conditions = utils.formatConditions(options)
        return conditions.length
          ? `已删除${conditions.join('、')}的统计记录`
          : '已删除所有统计记录'
      })
  }

  if (config.enableImport) {
    stat.subcommand('.import', '导入历史统计数据', { authority: 3 })
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
