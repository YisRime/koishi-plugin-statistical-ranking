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
      await ctx.database.upsert('analytics.stat', [{
        platform: data.platform,
        guildId: data.guildId,
        userId: data.userId,
        command: data.command ?? null,
        userName: data.userName || '',
        guildName: data.guildName || '',
        count: 1,
        lastTime: new Date()
      }], ['count'])
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
    const hasLegacyTable = Object.keys(ctx.database.tables).includes('analytics.command')
    if (!hasLegacyTable) throw new Error('未找到历史数据表')

    const total = await ctx.database.get('analytics.command', {}, ['count']).then(res => Number(res || 0))
    if (!total) throw new Error('历史数据为空')

    session?.send(`开始导入 ${total} 条记录...`)

    if (overwrite) {
      await ctx.database.remove('analytics.stat', {})
      session?.send('已清空现有数据')
    }

    const bindings = await ctx.database.get('binding', {})
    const userIdMap = new Map(bindings
      .filter(b => b.aid)
      .map(b => [b.aid.toString(), { pid: b.pid, platform: b.platform }]))

    const batchSize = 1000
    let processed = 0
    const stats = { imported: 0, skipped: 0, error: 0 }

    while (processed < total) {
      const commands = await ctx.database.get('analytics.command', {}, {
        limit: batchSize,
        offset: processed
      })

      const records = new Map()

      for (const cmd of commands) {
        try {
          const binding = userIdMap.get(cmd.userId.toString())
          if (!binding) {
            stats.skipped++
            continue
          }

          const key = `${binding.platform}:${cmd.channelId || 'private'}:${binding.pid}:${cmd.name || ''}`
          const timestamp = new Date(cmd.date * 86400000 + cmd.hour * 3600000)

          const current = records.get(key) || {
            platform: binding.platform,
            guildId: cmd.channelId || 'private',
            userId: binding.pid,
            command: cmd.name || '',
            count: 0,
            lastTime: timestamp
          }

          current.count += (cmd.count || 1)
          if (timestamp > current.lastTime) current.lastTime = timestamp
          records.set(key, current)

        } catch (e) {
          stats.error++
          ctx.logger.error('处理记录失败:', e, cmd)
        }
      }

      try {
        const batch = Array.from(records.values())
        await ctx.database.upsert('analytics.stat', batch, ['count'])
        stats.imported += batch.length
      } catch (e) {
        stats.error += records.size
        ctx.logger.error('批量更新失败:', e)
      }

      processed += commands.length
      session?.send(`处理进度: ${processed}/${total}`)
    }

    return `导入完成：成功 ${stats.imported} 条，跳过 ${stats.skipped} 条，失败 ${stats.error} 条`
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
