import { Context } from 'koishi'
import { Config, StatRecord } from './index'
import { utils } from './utils'

interface Target {
  platform: string
  guildId: string
  userId: string
}

/**
 * @internal
 * 数据库操作相关函数集合
 */
export const database = {
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

    // 获取用户ID绑定关系
    const bindings = await ctx.database.get('binding', {})
    // 创建aid到pid的映射
    const userIdMap = new Map<string, { pid: string; platform: string }>()
    for (const binding of bindings) {
      if (binding.aid) {  // 使用aid作为key
        userIdMap.set(binding.aid.toString(), {
          pid: binding.pid,
          platform: binding.platform
        })
      }
    }

    const batchSize = 100
    let importedCount = 0
    let errorCount = 0
    let skippedCount = 0

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
        // 通过aid查找对应的pid
        const binding = userIdMap.get(cmd.userId.toString())
        if (!binding) {
          skippedCount++
          continue // 跳过未找到绑定关系的记录
        }

        const platform = binding.platform || cmd.platform || 'unknown'
        const userId = binding.pid // 使用binding中的pid
        const command = cmd.name || ''
        const guildId = cmd.channelId || 'private'

        if (!userId) {
          ctx.logger.warn('Invalid user ID mapping:', { cmd, binding })
          skippedCount++
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
              lastTime: record.lastTime > existing.lastTime ? record.lastTime : existing.lastTime
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
    }${skippedCount ? `，跳过 ${skippedCount} 条` : ''}`
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
