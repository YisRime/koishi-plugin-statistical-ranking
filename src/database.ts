import { Context } from 'koishi'
import { StatRecord } from './index'
import { Utils } from './utils'

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
    data.command ||= '_message'

    if (data.guildId && data.guildId.includes('private')) {
      return;
    }
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
   * 注册清除命令
   * @param {Context} ctx Koishi 上下文
   * @param {any} parent 父命令对象
   */
  registerClearCommand(ctx: Context, parent: any) {
    /**
     * 统计数据清除子命令
     * 用于清除特定条件下的统计数据
     */
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
        // 检查是否只指定了below选项或time选项
        const onlyBelowSpecified = options.below > 0 &&
          !Object.values(cleanOptions).some(Boolean) && options.time <= 0;
        const onlyBeforeSpecified = options.time > 0 &&
          !Object.values(cleanOptions).some(Boolean) && options.below <= 0;
        // 检查是否没有指定任何条件
        if (!options.below && !options.time && !Object.values(cleanOptions).some(Boolean)) {
          ctx.logger.info('正在删除所有统计记录并重建数据表...')
          await ctx.database.drop('analytics.stat')
          await this.initialize(ctx)
          ctx.logger.info('已删除所有统计记录')
          return '已删除所有统计记录'
        }
        // 构建查询条件
        const query: any = Utils.filterObject(cleanOptions)
        // 添加记录数阈值条件
        if (options.below > 0) {
          query.count = { $lt: options.below }
        }
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
        const conditions = Utils.buildConditions(options)
        let message = '';
        const belowText = options.below > 0 ? `少于${options.below}次` : '';
        const beforeText = options.time > 0 ? `${options.time}天前` : '';
        const thresholdText = [belowText, beforeText].filter(Boolean).join('且');
        if (onlyBelowSpecified) {
          message = `已删除所有少于${options.below}次的统计记录`;
        } else if (onlyBeforeSpecified) {
          message = `已删除所有${options.time}天前的统计记录`;
        } else if (conditions.length) {
          message = `已删除${conditions.join('、')}的统计记录`;
          if (thresholdText) {
            message += `中${thresholdText}的记录`;
          }
        } else {
          message = `已删除所有统计记录`;
        }
        message += `（共${deleteCount}条）`;
        return message
      })
  }
}
