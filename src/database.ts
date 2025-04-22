import { Context } from 'koishi'
import { StatRecord } from './index'
import { Utils } from './utils'
import { DailyRecord } from './rank'

/**
 * @internal
 * 数据库操作相关函数集合
 * @description 提供数据库初始化、记录保存等核心功能
 */
export const database = {
  /**
   * 初始化数据库表结构
   * @param ctx - Koishi 上下文
   * @param enableDaily - 是否初始化日常统计相关表
   * @description 创建并定义表结构
   */
  initialize(ctx: Context, enableDaily: boolean = false) {
    // 初始化统计表
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
    if (enableDaily) {
      // 初始化日常统计表
      ctx.model.extend('analytics.daily', {
        id: 'unsigned',
        platform: { type: 'string', length: 60 },
        guildId: { type: 'string', length: 150 },
        userId: { type: 'string', length: 150 },
        userName: { type: 'string', nullable: true },
        guildName: { type: 'string', nullable: true },
        date: 'string',
        count: 'unsigned',
      }, {
        primary: 'id',
        autoInc: true,
        unique: [['platform', 'guildId', 'userId', 'date']],
      })
    }
  },

  /**
   * 保存统计记录
   * @param ctx - Koishi 上下文
   * @param data - 需要保存的记录数据
   * @description 更新或插入统计记录
   */
  async saveRecord(ctx: Context, data: Partial<StatRecord>) {
    data.command ||= '_message'
    if (data.guildId?.includes('private')) return;
    try {
      const query = {
        platform: data.platform,
        guildId: data.guildId,
        userId: data.userId,
        command: data.command
      }
      const normalizedData = Utils.normalizeRecord(data, { sanitizeNames: true });
      const userName = normalizedData.userName;
      const guildName = normalizedData.guildName;
      const [existing] = await ctx.database.get('analytics.stat', query)
      if (existing) {
        const updateData: Partial<StatRecord> = {
          count: existing.count + 1,
          lastTime: new Date()
        }
        if (userName !== undefined) updateData.userName = userName
        if (guildName !== undefined) updateData.guildName = guildName
        await ctx.database.set('analytics.stat', query, updateData)
      } else {
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
   * 保存或更新日常统计记录
   * @param ctx - Koishi 上下文
   * @param records - 日常统计记录数组
   * @param date - 日期字符串 (YYYY-MM-DD)
   * @returns {Promise<{ savedCount: number }>} 保存的记录数
   */
  async saveDailyRecords(
    ctx: Context,
    records: Map<string, DailyRecord>,
    date: string
  ): Promise<{ savedCount: number }> {
    let savedCount = 0
    try {
      // 查询已存在的记录，避免重复创建
      const existingRecords = await ctx.database.get('analytics.daily', { date })
      const existingKeys = new Set(
        existingRecords.map(r => `${r.platform}:${r.guildId}:${r.userId}`)
      )
      // 批量处理每条记录
      for (const record of records.values()) {
        const key = `${record.platform}:${record.guildId}:${record.userId}`
        try {
          // 检查记录是否已存在
          if (existingKeys.has(key)) {
            // 更新现有记录
            await ctx.database.set('analytics.daily', {
              platform: record.platform,
              guildId: record.guildId,
              userId: record.userId,
              date
            }, {
              count: record.count,
              userName: record.userName,
              guildName: record.guildName
            })
          } else {
            // 创建新记录
            await ctx.database.create('analytics.daily', record)
          }
          savedCount++
        } catch (err) {
          ctx.logger.error(`保存日常统计记录失败:`, err)
        }
      }
      return { savedCount }
    } catch (e) {
      ctx.logger.error('批量保存日常统计记录失败:', e)
    }
  },

  /**
   * 注册清除命令
   * @param {Context} ctx Koishi 上下文
   * @param {any} parent 父命令对象
   */
  registerClearCommand(ctx: Context, parent: any) {
    parent.subcommand('.clear', '清除统计数据', { authority: 4 })
      .option('user', '-u [user:string] 指定用户')
      .option('platform', '-p [platform:string] 指定平台')
      .option('guild', '-g [guild:string] 指定群组')
      .option('command', '-c [command:string] 指定命令')
      .option('below', '-b [count:number] 少于指定次数', { fallback: 0 })
      .option('time', '-t [days:number] 指定天数之前', { fallback: 0 })
      .action(async ({ options }) => {
        // 转换选项键名以匹配数据库字段名
        const cleanOptions = {
          userId: options.user,
          platform: options.platform,
          guildId: options.guild,
          command: options.command
        }
        // 检查是否没有指定任何条件
        if (!options.below && !options.time && !Object.values(cleanOptions).some(Boolean)) {
          ctx.logger.info('正在删除所有统计记录并重建数据表...')
          await ctx.database.drop('analytics.stat')
          await this.initialize(ctx)
          ctx.logger.info('已删除所有统计记录')
          return '已删除所有统计记录'
        }
        // 在删除前查询以获取用户和群组的昵称
        let userName = '', guildName = ''
        if (options.user) {
          const userRecords = await ctx.database.get('analytics.stat', { userId: options.user })
          const userRecord = userRecords.find(r => r.userName)
          userName = userRecord?.userName || ''
        }
        if (options.guild) {
          const guildRecords = await ctx.database.get('analytics.stat', { guildId: options.guild })
          const guildRecord = guildRecords.find(r => r.guildName)
          guildName = guildRecord?.guildName || ''
        }
        // 构建查询条件
        const query: any = Object.fromEntries(
          Object.entries(cleanOptions).filter(([_, value]) => Boolean(value))
        );
        // 添加记录数阈值条件
        if (options.below > 0) { query.count = { $lt: options.below } }
        // 添加时间阈值条件
        if (options.time > 0) {
          const cutoffDate = new Date();
          cutoffDate.setDate(cutoffDate.getDate() - options.time);
          query.lastTime = { $lt: cutoffDate };
        }
        // 统计将要删除的记录数
        const recordsToDelete = await ctx.database.get('analytics.stat', query, ['id'])
        const deleteCount = recordsToDelete.length
        // 执行删除操作
        await ctx.database.remove('analytics.stat', query)
        // 构建条件描述
        const conditions = Utils.buildConditions({
          user: options.user ? (userName || options.user) : null,
          guild: options.guild ? (guildName || options.guild) : null,
          platform: options.platform,
          command: options.command
        })
        const thresholdConditions = [
          options.below > 0 && `少于${options.below}次`,
          options.time > 0 && `在${options.time}天前`
        ].filter(Boolean);
        // 组装最终消息
        let message = '已删除';
        message += conditions.length ? `${conditions.join('、')}的` : '所有';
        if (thresholdConditions.length) {
          message += `${thresholdConditions.join('且')}的`;
        }
        message += `统计记录（共${deleteCount}条）`;
        return message;
      })
  }
}