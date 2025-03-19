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
      .action(async ({ options }) => {
        // 转换选项键名以匹配数据库字段名
        const cleanOptions = {
          userId: options.user,
          platform: options.platform,
          guildId: options.guild,
          command: options.command
        }
        // 检查是否有任何条件被指定
        if (!Object.values(cleanOptions).some(Boolean)) {
          ctx.logger.info('正在删除所有统计记录并重建数据表...')
          await ctx.database.drop('analytics.stat')
          await this.initialize(ctx)
          ctx.logger.info('已删除所有统计记录')
          return '已删除所有统计记录'
        }
        // 删除匹配条件的记录
        const query = Utils.filterObject(cleanOptions)
        await ctx.database.remove('analytics.stat', query)
        ctx.logger.info(`已删除所选统计记录`)
        // 构建条件描述
        const conditions = Utils.buildConditions(options)
        return conditions.length
          ? `已删除${conditions.join('、')}的统计记录`
          : `已删除所有统计记录`
      })
  }
}
