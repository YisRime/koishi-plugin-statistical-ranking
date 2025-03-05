import { Context } from 'koishi'
import { Config, StatRecord } from './index'
import { utils } from './utils'

/**
 * 目标对象接口
 * @interface Target
 * @description 用于权限检查的目标对象结构
 */
interface Target {
  platform: string
  guildId: string
  userId: string
}

/**
 * @internal
 * 数据库操作相关函数集合
 * @description 提供数据库初始化、记录保存、权限检查等核心功能
 */
export const database = {
  /**
   * 初始化数据库表结构
   * @param ctx - Koishi 上下文
   * @description 创建并定义 analytics.stat 表的结构
   */
  initialize(ctx: Context) {
    ctx.model.extend('analytics.stat', {
      platform: 'string',
      guildId: 'string',
      userId: 'string',
      command: { type: 'string', nullable: true },
      guildName: { type: 'string', nullable: true },
      userName: { type: 'string', nullable: true },
      count: 'unsigned',
      lastTime: 'timestamp',
    }, {
      primary: ['platform', 'guildId', 'userId', 'command'],
    })
  },

  /**
   * 保存统计记录
   * @param ctx - Koishi 上下文
   * @param data - 需要保存的记录数据
   * @description 检查权限并更新或插入统计记录
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
    if (!(await database.checkPermissions(config, target))) return

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

  /**
   * 批量更新或插入记录
   * @param ctx - Koishi 上下文
   * @param data - 记录数据
   * @description 使用 upsert 操作保存记录，出错时记录日志
   */
  async upsertRecord(ctx: Context, data: Partial<StatRecord>) {
    try {
      const query = {
        platform: data.platform,
        guildId: data.guildId,
        userId: data.userId,
        command: data.command ?? null
      }

      const existing = await ctx.database.get('analytics.stat', query)

      if (existing.length) {
        await ctx.database.set('analytics.stat', query, {
          userName: data.userName || existing[0].userName || '',
          guildName: data.guildName || existing[0].guildName || '',
          count: existing[0].count + 1,
          lastTime: new Date()
        })
      } else {
        await ctx.database.create('analytics.stat', {
          ...query,
          userName: data.userName || '',
          guildName: data.guildName || '',
          count: 1,
          lastTime: new Date()
        })
      }
    } catch (e) {
      ctx.logger.error('保存记录失败:', e, data)
    }
  },

  /**
   * 导入历史数据
   * @param ctx Koishi上下文
   * @param session 会话对象
   * @param overwrite 是否覆盖现有数据
   */
  async importLegacyData(ctx: Context, session?: any, overwrite = false) {
    try {
      if (!ctx.database.tables['analytics.command']) {
        throw new Error('找不到历史数据表')
      }

      const [records, bindings] = await Promise.all([
        ctx.database.get('analytics.command', {}),
        ctx.database.get('binding', {})
      ])

      if (!records.length) throw new Error('历史数据为空')
      session?.send(`开始导入 ${records.length} 条记录...`)

      const stats = { imported: 0, skipped: 0, error: 0 }
      const skipReasons = new Map<string, number>()
      const mergedRecords = new Map()
      const userIdMap = new Map(bindings
        .filter(b => b.aid)
        .map(b => [b.aid.toString(), { pid: b.pid, platform: b.platform }]))

      overwrite && await ctx.database.remove('analytics.stat', {})

      records.forEach(cmd => {
        if (!cmd.userId || !cmd.channelId || !userIdMap.has(cmd.userId.toString()) ||
            !cmd.date || !Number.isFinite(cmd.date) || !Number.isFinite(cmd.hour)) {
          skipReasons.set('记录无效或缺少绑定数据', (skipReasons.get('记录无效或缺少绑定数据') || 0) + 1)
          stats.skipped++
          return
        }

        const binding = userIdMap.get(cmd.userId.toString())
        const key = `${binding.platform}:${cmd.channelId}:${binding.pid}:${cmd.name || ''}`
        const timestamp = new Date(Math.max(0, (cmd.date * 86400000) + ((cmd.hour || 0) * 3600000)))

        if (isNaN(timestamp.getTime())) {
          skipReasons.set('时间戳无效', (skipReasons.get('时间戳无效') || 0) + 1)
          stats.skipped++
          return
        }

        const existingRecord = mergedRecords.get(key)
        mergedRecords.set(key, {
          platform: binding.platform,
          guildId: cmd.channelId,
          userId: binding.pid,
          command: cmd.name || null,
          count: (existingRecord?.count || 0) + (cmd.count || 1),
          lastTime: existingRecord
            ? new Date(Math.max(existingRecord.lastTime.getTime(), timestamp.getTime()))
            : timestamp
        })
      })

      const batch = Array.from(mergedRecords.values())
      await Promise.all(batch.map(async record => {
        try {
          const query = {
            platform: record.platform,
            guildId: record.guildId,
            userId: record.userId,
            command: record.command
          }

          const [existing] = await ctx.database.get('analytics.stat', query)
          const update = {
            count: record.count,
            lastTime: record.lastTime,
            userName: '',
            guildName: ''
          }

          if (existing && !overwrite) {
            update.count += existing.count
            update.lastTime = new Date(Math.max(
              existing.lastTime?.getTime() || 0,
              record.lastTime.getTime()
            ))
            update.userName = existing.userName || ''
            update.guildName = existing.guildName || ''
          }

          await ctx.database[existing ? 'set' : 'create']('analytics.stat', query, update)
          stats.imported++
        } catch (err) {
          ctx.logger.warn('导入单条记录失败:', err)
          stats.error++
        }
      }))

      return [
        `导入完成：总计 ${records.length} 条记录`,
        `- 成功：${stats.imported} 条`,
        `- 跳过：${stats.skipped} 条`,
        `- 失败：${stats.error} 条`,
        skipReasons.size ? '\n跳过原因：' : '',
        ...Array.from(skipReasons).map(([reason, count]) => `- ${reason}: ${count} 条`)
      ].filter(Boolean).join('\n')

    } catch (e) {
      ctx.logger.error('导入失败:', e)
      throw e
    }
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
      await database.initialize(ctx)
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
