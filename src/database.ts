import { Context } from 'koishi'
import { Config, StatRecord } from './index'
import { utils } from './utils'

/**
 * @internal
 * 数据库操作相关函数集合
 * @description 提供数据库初始化、记录保存等核心功能
 */
export const database = {
  /**
   * 初始化数据库表结构
   * @param ctx - Koishi 上下文
   * @description 创建并定义 analytics.stat 表的结构
   */
  initialize(ctx: Context) {
    ctx.model.extend('analytics.stat', {
      id: 'unsigned',
      platform: { type: 'string', length: 60 },
      guildId: { type: 'string', length: 150 },
      userId: { type: 'string', length: 150 },
      command: { type: 'string', length: 150 },
      guildName: { type: 'string', nullable: true },
      userName: { type: 'string', nullable: true },
      count: 'unsigned',
      lastTime: 'timestamp',
    }, {
      primary: 'id',
      autoInc: true,
      unique: [['platform', 'guildId', 'userId', 'command']],
    })
  },

  /**
   * 保存统计记录
   * @param ctx - Koishi 上下文
   * @param data - 需要保存的记录数据
   * @description 更新或插入统计记录
   */
  async saveRecord(ctx: Context, data: Partial<StatRecord>) {
    if (!data.platform || !data.guildId || !data.userId) {
      ctx.logger.warn('Invalid record data:', data)
      return
    }

    // 设置默认命令值
    data.command ||= 'mess_age'

    try {
      const query = {
        platform: data.platform,
        guildId: data.guildId,
        userId: data.userId,
        command: data.command
      }

      const userName = data.userName !== undefined ? utils.sanitizeString(data.userName) : undefined
      const guildName = data.guildName !== undefined ? utils.sanitizeString(data.guildName) : undefined

      const [existing] = await ctx.database.get('analytics.stat', query)
      if (existing) {
        // 更新现有记录
        const updateData: Partial<StatRecord> = {
          count: existing.count + 1,
          lastTime: new Date()
        }

        // 只在有新值时更新用户名和群组名
        if (userName !== undefined) updateData.userName = userName
        if (guildName !== undefined) updateData.guildName = guildName

        await ctx.database.set('analytics.stat', query, updateData)
      } else {
        // 创建新记录
        await ctx.database.create('analytics.stat', {
          ...query,
          userName,
          guildName,
          count: 1,
          lastTime: new Date()
        })
      }
    } catch (e) {
      ctx.logger.error('保存记录失败:', e, data)
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
    // 检查是否有任何过滤条件
    if (!Object.values(options).some(Boolean)) {
      await ctx.database.drop('analytics.stat')
      await database.initialize(ctx)
      return -1
    }

    // 简化查询构建逻辑，直接过滤掉假值
    const query = Object.fromEntries(
      Object.entries(options).filter(([_, value]) => Boolean(value))
    )

    const result = await ctx.database.remove('analytics.stat', query)
    return Number(result ?? 0)
  }
}
