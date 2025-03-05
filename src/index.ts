import { Context, Schema } from 'koishi'

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

type NameType = 'user' | 'guild'

interface QueryOptions {
  user?: string
  guild?: string
  platform?: string
  command?: string
}

interface Target {
  platform: string
  guildId: string
  userId: string
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
 * @property {string} [userNickname] - 用户昵称
 * @property {string} [command] - 命令名称
 * @property {number} count - 记录次数
 * @property {Date} lastTime - 最后记录时间
 * @property {string} [guildName] - 群组名称
 */
interface StatRecord {
  platform: string
  guildId: string
  userId: string
  userNickname?: string
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
 * @internal
 * 统计数据聚合管理器
 * 用于处理和聚合统计数据，支持自定义键格式化
 */
class StatMap {
  private data = new Map<string, { count: number, lastTime: Date }>()
  private keyFormat: (key: string) => string

  constructor(keyFormat?: (key: string) => string) {
    this.keyFormat = keyFormat || ((k) => k)
  }

  add(key: string, count: number, time: Date) {
    const formattedKey = this.keyFormat(key)
    const curr = this.data.get(formattedKey) || { count: 0, lastTime: time }
    curr.count += count
    if (time > curr.lastTime) curr.lastTime = time
    this.data.set(formattedKey, curr)
  }

  addRecord(record: StatRecord, key: keyof StatRecord) {
    this.add(record[key] as string, record.count, record.lastTime)
  }

  entries() {
    return Array.from(this.data.entries())
  }

  sortedEntries(sortBy: 'count' | 'key' = 'count') {
    return this.entries().sort((a, b) =>
      sortBy === 'count'
        ? b[1].count - a[1].count
        : a[0].localeCompare(b[0])
    )
  }
}

/**
 * @internal
 * 工具函数集合对象
 */
const utils = {
  /**
   * 统一处理异步获取名称的错误
   * @param fn - 异步函数，用于获取名称
   * @returns 获取到的名称或null
   */
  async safeGetName(fn: () => Promise<any>): Promise<string | null> {
    try {
      const result = await fn()
      return result?.nickname || result?.username || result?.name || null
    } catch {
      return null
    }
  },

  /**
   * @private
   * 名称获取队列相关变量
   */
  _nameQueue: new Map<string, Promise<string>>(),
  _queueCount: 0,
  _batchSize: 10,
  _batchDelay: 100,

  /**
   * 批量获取用户或群组名称
   * @param session - Koishi会话对象
   * @param id - 用户或群组ID
   * @param type - 类型：'user' 或 'guild'
   * @returns Promise<string> 名称或ID
   */
  async getName(session: any, id: string, type: NameType): Promise<string> {
    const cacheKey = `${type}:${id}`

    if (utils._nameQueue.has(cacheKey)) {
      return utils._nameQueue.get(cacheKey)
    }

    const namePromise = (async () => {
      const name = await (type === 'user'
        ? utils.safeGetName(() => session.bot.getGuildMember?.(session.guildId, id))
        : utils.safeGetName(() => session.bot.getGuild?.(id)))

      return name || id
    })()

    utils._nameQueue.set(cacheKey, namePromise)
    utils._queueCount++

    if (utils._queueCount >= utils._batchSize) {
      await new Promise(resolve => setTimeout(resolve, utils._batchDelay))
      utils._nameQueue.clear()
      utils._queueCount = 0
    }

    return namePromise
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
   * 验证和规范化查询选项
   * @param options - 查询选项对象
   * @returns 标准化后的查询选项
   */
  normalizeQueryOptions(options: QueryOptions): Required<QueryOptions> {
    return {
      user: options.user || '',
      guild: options.guild || '',
      platform: options.platform || '',
      command: options.command || ''
    }
  },

  /**
   * 格式化查询条件为可读文本
   * @param options - 查询选项
   * @returns 格式化后的条件数组
   */
  formatConditions(options: QueryOptions): string[] {
    const normalized = utils.normalizeQueryOptions(options)
    return Object.entries(normalized)
      .filter(([_, value]) => value)
      .map(([key, value]) => {
        switch(key) {
          case 'user': return `用户 ${value}`
          case 'guild': return `群组 ${value}`
          case 'platform': return `平台 ${value}`
          case 'command': return `命令 ${value}`
          default: return ''
        }
      })
      .filter(Boolean)
  },

  /**
   * 将查询选项转换为数据库查询条件
   * @param options 查询选项
   * @returns 数据库查询对象
   */
  buildQueryFromOptions(options: QueryOptions) {
    const normalized = utils.normalizeQueryOptions(options)
    const query: Record<string, any> = {}

    if (normalized.user) query.userId = normalized.user
    if (normalized.guild) query.guildId = normalized.guild
    if (normalized.platform) query.platform = normalized.platform
    if (normalized.command) query.command = normalized.command

    return query
  },

  /**
   * 处理统计记录，聚合并格式化结果
   * @param records 统计记录数组
   * @param aggregateKey 聚合键名
   * @param formatFn 可选的格式化函数
   * @param sortBy 排序方式：'count' 按次数或 'key' 按键名
   * @param truncateId 是否截断ID (仅用于展示用户/群组ID)
   * @returns 格式化后的结果数组
   */
  async processStatRecords(
    records: StatRecord[],
    aggregateKey: keyof StatRecord,
    formatFn?: (key: string, data: { count: number, lastTime: Date }) => Promise<string>,
    sortBy: 'count' | 'key' = 'count',
    truncateId = false
  ) {
    const keyFormat = aggregateKey === 'command'
      ? (k: string) => k?.split('.')[0] || ''
      : undefined

    const stats = new StatMap(keyFormat)
    for (const record of records) {
      stats.addRecord(record, aggregateKey)
    }

    const entries = stats.sortedEntries(sortBy)

    if (formatFn) {
      return Promise.all(entries.map(([key, data]) => formatFn(key, data)))
    }

    return entries.map(([key, {count, lastTime}]) => {
      const displayKey = truncateId ? key.slice(0, 10) : key
      return `${displayKey.padEnd(10, ' ')}${count.toString().padStart(5)}次 ${utils.formatTimeAgo(lastTime)}`
    })
  },

  /**
   * 检查目标是否匹配规则
   * @param rule 规则字符串 platform:guild:user
   * @param target 目标对象
   * @returns 是否匹配
   */
  matchRule(rule: string, target: { platform: string, guildId: string, userId: string }): boolean {
    const parts = rule.split(':')
    const [rulePlatform = '', ruleGuild = '', ruleUser = ''] = parts

    if (ruleUser && target.userId === ruleUser) return true
    if (ruleGuild && target.guildId === ruleGuild) return true
    if (rulePlatform && target.platform === rulePlatform) return true

    return false
  },

  /**
   * 检查目标是否在列表中匹配
   * @param list 规则列表
   * @param target 目标对象
   * @returns 是否匹配
   */
  matchRuleList(list: string[], target: { platform: string, guildId: string, userId: string }): boolean {
    return list.some(rule => utils.matchRule(rule, target))
  },

  /**
   * 获取统计数据中的唯一键列表
   * @param records 统计记录数组
   * @param key 要提取的键名
   * @returns 唯一值数组
   */
  getUniqueKeys(records: StatRecord[], key: keyof StatRecord): string[] {
    const stats = new StatMap()
    for (const record of records) {
      stats.add(record[key] as string, 0, new Date())
    }
    return stats.entries().map(([key]) => key).filter(Boolean)
  },

  /**
   * 获取会话的群组ID
   * @param session 会话对象
   * @returns 群组ID
   */
  getGuildId(session: any): string {
    return session.guildId || session.groupId || session.channelId || 'private'
  },

  /**
   * 获取用户的平台ID
   * @param session 会话对象
   * @returns Promise<string> 平台ID
   */
  async getPlatformId(session: any): Promise<string> {
    if (!session?.userId) return ''

    const [binding] = await session.ctx.database.get('binding', {
      aid: session.userId,
      platform: session.platform
    })

    if (binding?.pid) {
      return binding.pid
    }

    return session.userId
  },
}

/**
 * @internal
 * 数据库操作相关函数集合
 */
const database = {
  /**
   * 初始化数据库表结构
   * @param ctx - Koishi上下文
   */
  initialize(ctx: Context) {
    ctx.model.extend('analytics.stat', {
      platform: 'string',
      guildId: 'string',
      userId: 'string',
      command: { type: 'string', nullable: true },
      guildName: { type: 'string', nullable: true },
      userNickname: { type: 'string', nullable: true },
      count: 'unsigned',
      lastTime: 'timestamp',
    }, {
      primary: ['platform', 'guildId', 'userId', 'command'],
    })
  },

  /**
   * 保存统计记录
   * @param ctx Koishi上下文
   * @param data 记录数据
   */
  async saveRecord(ctx: Context, data: Partial<StatRecord>) {
    if (!data.platform || !data.guildId || !data.userId) {
      ctx.logger.warn('Invalid record data:', data)
      return
    }

    const target = {
      platform: data.platform,
      guildId: data.guildId,
      userId: data.userId
    }

    const config = ctx.config.statistical_ranking

    if (!await database.checkPermissions(config, target)) {
      return
    }

    await database.upsertRecord(ctx, data)
  },

  /**
   * 检查操作权限
   * @param config - 插件配置
   * @param target - 目标对象
   * @returns 是否有权限
   */
  async checkPermissions(config: Config, target: Target): Promise<boolean> {
    if (config?.enableBlacklist && config?.blacklist?.length) {
      if (utils.matchRuleList(config.blacklist, target)) {
        return false
      }
    }
    if (config?.enableWhitelist && config?.whitelist?.length) {
      if (!utils.matchRuleList(config.whitelist, target)) {
        return false
      }
    }
    return true
  },

  async upsertRecord(ctx: Context, data: Partial<StatRecord>) {
    const query = {
      platform: data.platform,
      guildId: data.guildId,
      userId: data.userId,
      command: data.command ?? null,
    }

    if (!query.platform || !query.guildId || !query.userId) {
      ctx.logger.warn('Missing required fields:', query)
      return
    }

    try {
      const [existing] = await ctx.database.get('analytics.stat', query)
      const bot = ctx.bots.find(bot => bot.platform === data.platform)

      const [userInfo, guildInfo] = await Promise.all([
        data.guildId === 'private'
          ? bot?.getUser?.(data.userId).catch(() => null)
          : bot?.getGuildMember?.(data.guildId, data.userId).catch(() => null),
        data.guildId === 'private'
          ? null
          : bot?.getGuild?.(data.guildId).catch(() => null)
      ])

      const updateData = {
        count: (existing?.count || 0) + 1,
        lastTime: new Date(),
        userNickname: userInfo?.nickname || userInfo?.name || userInfo?.username || existing?.userNickname || '',
        guildName: guildInfo?.name || existing?.guildName || '',
      }

      if (existing) {
        await ctx.database.set('analytics.stat', query, updateData)
      } else {
        const checkExisting = await ctx.database.get('analytics.stat', query)
        if (!checkExisting.length) {
          await ctx.database.create('analytics.stat', {
            ...query,
            ...updateData,
            count: 1,
          })
        } else {
          await ctx.database.set('analytics.stat', query, updateData)
        }
      }
    } catch (e) {
      ctx.logger.error('Failed to save stat record:', e, query)
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
      throw new Error('未找到记录')
    }

    const legacyCommands = await ctx.database.get('analytics.command', {})
    session?.send(`发现 ${legacyCommands.length} 条命令记录`)

    if (overwrite) {
      await ctx.database.remove('analytics.stat', {})
    }

    const bindings = await ctx.database.get('binding', {})
    const userIdMap = new Map<string, { pid: string; platform: string }>()
    for (const binding of bindings) {
      if (binding.pid && binding.aid) {
        userIdMap.set(`${binding.aid}`, {
          pid: binding.pid,
          platform: binding.platform
        })
      }
    }

    const batchSize = 100
    let importedCount = 0
    let errorCount = 0

    const processedRecords = new Map<string, {
      platform: string
      guildId: string
      userId: string
      command: string
      count: number
      lastTime: Date
    }>()

    for (const cmd of legacyCommands) {
      try {
        const binding = userIdMap.get(`${cmd.userId}`)
        const platform = binding?.platform || cmd.platform || 'unknown'
        const userId = binding?.pid || `${cmd.userId}`
        const command = cmd.name || ''
        const guildId = cmd.channelId || 'private'

        if (!userId) {
          ctx.logger.warn('Invalid user ID:', cmd)
          continue
        }

        const key = `${platform}:${guildId}:${userId}:${command}`
        const existing = processedRecords.get(key)
        const timestamp = cmd.date * 86400000 + cmd.hour * 3600000
        const cmdTime = new Date(timestamp)
        const lastTime = isNaN(cmdTime.getTime()) || cmdTime.getTime() > Date.now()
          ? new Date()
          : cmdTime

        if (existing) {
          existing.count += (cmd.count || 1)
          if (lastTime > existing.lastTime) {
            existing.lastTime = lastTime
          }
        } else {
          processedRecords.set(key, {
            platform,
            guildId,
            userId,
            command,
            count: cmd.count || 1,
            lastTime
          })
        }
      } catch (e) {
        errorCount++
        ctx.logger.error('Failed to process record:', e, cmd)
      }
    }

    const records = Array.from(processedRecords.values())
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize)

      await Promise.all(batch.map(async (record) => {
        try {
          const query = {
            platform: record.platform,
            guildId: record.guildId,
            userId: record.userId,
            command: record.command,
          }

          const [existing] = await ctx.database.get('analytics.stat', query)
          if (existing) {
            await ctx.database.set('analytics.stat', query, {
              count: existing.count + record.count,
              lastTime: record.lastTime
            })
          } else {
            await ctx.database.create('analytics.stat', {
              ...query,
              count: record.count,
              lastTime: record.lastTime,
            })
          }
          importedCount++
        } catch (e) {
          errorCount++
          ctx.logger.error('Failed to import record:', e, record)
        }
      }))
    }

    return `导入完成，成功导入 ${importedCount} 条记录${
      errorCount ? `，失败 ${errorCount} 条` : ''
    }`
  },

  /**
   * 清除统计数据
   * @param ctx Koishi上下文
   * @param options 清除选项
   * @returns 清除的记录数量
   */
  async clearStats(ctx: Context, options: {
    userId?: string
    platform?: string
    guildId?: string
    command?: string
  }) {

    if (!Object.values(options).some(Boolean)) {
      await ctx.database.drop('analytics.stat')
      return -1
    }

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

  ctx.on('command/before-execute', async ({session, command}) =>
    database.saveRecord(ctx, {
      platform: session.platform,
      guildId: utils.getGuildId(session),
      userId: await utils.getPlatformId(session),
      command: command.name
    }))

  ctx.on('message', async (session) =>
    database.saveRecord(ctx, {
      platform: session.platform,
      guildId: utils.getGuildId(session),
      userId: await utils.getPlatformId(session),
      command: null
    }))

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

      const nicknameStats = new StatMap()
      for (const record of records) {
        if (record.userNickname) {
          nicknameStats.add(record.userId, 0, new Date())
        }
      }

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
