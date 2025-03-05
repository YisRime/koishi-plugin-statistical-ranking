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
      if (!Object.keys(ctx.database.tables).includes('analytics.command')) {
        throw new Error('找不到历史数据表')
      }

      const records = await ctx.database.get('analytics.command', {})
      if (!records.length) throw new Error('历史数据为空')

      session?.send(`开始导入 ${records.length} 条记录...`)

      if (overwrite) {
        await ctx.database.remove('analytics.stat', {})
        session?.send('已清空现有数据')
      }

      const bindings = await ctx.database.get('binding', {})
      const userIdMap = new Map(bindings
        .filter(b => b.aid)
        .map(b => [b.aid.toString(), { pid: b.pid, platform: b.platform }]))

      const stats = { imported: 0, skipped: 0, error: 0 }
      const skipReasons = new Map<string, number>()
      const mergedRecords = new Map()

      for (const cmd of records) {
        try {
          if (!cmd.userId || !cmd.channelId) {
            this.incrementStat(skipReasons, '记录缺少必要字段', stats, 'skipped')
            continue
          }

          const binding = userIdMap.get(cmd.userId.toString())
          if (!binding) {
            this.incrementStat(skipReasons, `未找到用户 ${cmd.userId} 的绑定数据`, stats, 'skipped')
            continue
          }

          const timestamp = new Date((cmd.date * 86400000) + (cmd.hour * 3600000))
          if (isNaN(timestamp.getTime())) {
            this.incrementStat(skipReasons, `无效时间戳: date=${cmd.date}, hour=${cmd.hour}`, stats, 'error')
            continue
          }

          const key = `${binding.platform}:${cmd.channelId}:${binding.pid}:${cmd.name || ''}`
          const current = mergedRecords.get(key) || {
            platform: binding.platform,
            guildId: cmd.channelId,
            userId: binding.pid,
            command: cmd.name || null,
            count: 0,
            lastTime: timestamp
          }

          current.count += (cmd.count || 1)
          if (timestamp > current.lastTime) current.lastTime = timestamp
          mergedRecords.set(key, current)
        } catch (e) {
          this.incrementStat(skipReasons, e.message || '未知错误', stats, 'error')
          ctx.logger.error('处理记录失败:', e, cmd)
        }
      }

      if (mergedRecords.size) {
        const batch = Array.from(mergedRecords.values())
        for (const record of batch) {
          const query = {
            platform: record.platform,
            guildId: record.guildId,
            userId: record.userId,
            command: record.command
          }

          const existing = await ctx.database.get('analytics.stat', query)
          if (existing.length) {
            await ctx.database.set('analytics.stat', query, {
              count: existing[0].count + record.count,
              lastTime: record.lastTime > existing[0].lastTime ? record.lastTime : existing[0].lastTime
            })
          } else {
            await ctx.database.create('analytics.stat', record)
          }
        }
        stats.imported = batch.length
      }

      return this.generateReport(records.length, stats, skipReasons)
    } catch (e) {
      const errorMsg = `导入失败：${e.message}`
      ctx.logger.error(errorMsg)
      throw new Error(errorMsg)
    }
  },

  incrementStat(reasons: Map<string, number>, reason: string, stats: any, type: 'skipped' | 'error') {
    reasons.set(reason, (reasons.get(reason) || 0) + 1)
    stats[type]++
  },

  generateReport(total: number, stats: any, reasons: Map<string, number>) {
    const report = [
      `导入完成：总计 ${total} 条记录`,
      `- 成功：${stats.imported} 条`,
      `- 跳过：${stats.skipped} 条`,
      `- 失败：${stats.error} 条`,
      '\n原因统计：'
    ]

    for (const [reason, count] of reasons) {
      report.push(`- ${reason}: ${count} 条`)
    }

    return report.join('\n')
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
