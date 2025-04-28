import { Context } from 'koishi'
import { StatRecord } from './index'
import { Utils } from './utils'

export const database = {
  /**
   * 初始化统计数据库表结构
   * @param ctx - Koishi 上下文
   * @description 创建并定义 analytics.stat 表的结构
   */
  initialize(ctx: Context) {
    ctx.model.extend('analytics.stat', {
      id: 'unsigned', platform: { type: 'string', length: 60 },
      guildId: { type: 'string', length: 150 }, userId: { type: 'string', length: 150 },
      command: { type: 'string', length: 150 }, guildName: { type: 'string', nullable: true },
      userName: { type: 'string', nullable: true }, count: 'unsigned', lastTime: 'timestamp',
    }, { primary: 'id', autoInc: true, unique: [['platform', 'guildId', 'userId', 'command']] })
  },

  /**
   * 初始化排行榜数据库表结构
   * @param ctx - Koishi 上下文
   * @description 创建并定义 analytics.rank 表的结构
   */
  initializeRankTable(ctx: Context) {
    ctx.model.extend('analytics.rank', {
      id: 'unsigned', stat: 'unsigned', timestamp: 'timestamp', count: 'unsigned'
    }, { primary: 'id', autoInc: true, unique: [['stat', 'timestamp']] })
  },

  /**
   * 保存统计记录
   * @param ctx - Koishi 上下文
   * @param data - 需要保存的记录数据
   * @description 更新或插入统计记录
   */
  async saveRecord(ctx: Context, data: Partial<StatRecord>) {
    data.command ??= '_message'
    if (data.guildId?.includes('private')) return;
    try {
      const query = { platform: data.platform, guildId: data.guildId, userId: data.userId, command: data.command }
      const normalizedData = Utils.normalizeRecord(data, { sanitizeNames: true });
      const [userName, guildName] = [normalizedData.userName, normalizedData.guildName];
      const [existing] = await ctx.database.get('analytics.stat', query)
      if (existing) {
        const updateData: Partial<StatRecord> = { count: existing.count + 1, lastTime: new Date() }
        if (userName !== undefined) updateData.userName = userName
        if (guildName !== undefined) updateData.guildName = guildName
        await ctx.database.set('analytics.stat', query, updateData)
      } else {
        await ctx.database.create('analytics.stat', { ...query, userName, guildName, count: 1, lastTime: new Date() })
      }
    } catch (e) { ctx.logger.error('保存记录失败:', e, data) }
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
      .option('below', '-b [count:number] 少于指定次数')
      .option('time', '-t [days:number] 指定天数之前')
      .option('rank', '-r 只删除排行数据')
      .option('drop', '-d 不重建数据表')
      .action(async ({ options }) => {
        const cleanOptions = { userId: options.user, platform: options.platform,
                              guildId: options.guild, command: options.command }
        if (options.rank && ctx.database.tables['analytics.rank']) {
          await ctx.database.drop('analytics.rank')
          if (!options.drop) {
            await this.initializeRankTable(ctx)
          }
          return options.drop ? '已删除所有排行记录（未重建表）' : '已删除所有排行记录'
        }
        if (!options.below && !options.time && !Object.values(cleanOptions).some(Boolean)) {
          ctx.logger.info('正在删除所有记录' + (options.drop ? '' : '并重建数据表') + '...')
          await ctx.database.drop('analytics.stat')
          if (ctx.database.tables['analytics.rank']) {
            await ctx.database.drop('analytics.rank')
            if (!options.drop) {
              await this.initializeRankTable(ctx)
            }
          }
          if (!options.drop) {
            await this.initialize(ctx)
          }
          ctx.logger.info('已删除所有记录' + (options.drop ? '（未重建表）' : ''))
          return '已删除所有记录' + (options.drop ? '（未重建表）' : '')
        }
        let [userName, guildName] = ['', '']
        if (options.user) {
          const userRecords = await ctx.database.get('analytics.stat', { userId: options.user })
          userName = userRecords.find(r => r.userName)?.userName
        }
        if (options.guild) {
          const guildRecords = await ctx.database.get('analytics.stat', { guildId: options.guild })
          guildName = guildRecords.find(r => r.guildName)?.guildName
        }
        const query: any = Object.fromEntries(Object.entries(cleanOptions).filter(([_, v]) => Boolean(v)));
        if (options.below > 0) query.count = { $lt: options.below };
        if (options.time > 0) {
          const cutoffDate = new Date();
          cutoffDate.setDate(cutoffDate.getDate() - options.time);
          query.lastTime = { $lt: cutoffDate };
        }
        const recordsToDelete = await ctx.database.get('analytics.stat', query, ['id'])
        const deleteCount = recordsToDelete.length
        if (ctx.database.tables['analytics.rank'] && deleteCount > 0) {
          await ctx.database.remove('analytics.rank', { stat: { $in: recordsToDelete.map(r => r.id) } })
        }
        await ctx.database.remove('analytics.stat', query)
        const conditions = Utils.buildConditions({
          user: options.user ? (userName || options.user) : null,
          guild: options.guild ? (guildName || options.guild) : null,
          platform: options.platform, command: options.command
        })
        const thresholdConditions = [
          options.below > 0 && `少于${options.below}次`,
          options.time > 0 && `在${options.time}天前`
        ].filter(Boolean);
        let message = '已删除' + (conditions.length ? `${conditions.join('、')}的` : '所有');
        if (thresholdConditions.length) message += `${thresholdConditions.join('且')}的`;
        message += `记录（共${deleteCount}条）`;
        return message;
      })
  }
}