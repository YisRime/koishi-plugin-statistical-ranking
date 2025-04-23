import { Context } from 'koishi'
import { StatRecord } from './index'
import { Utils } from './utils'
import { DailyRecord } from './rank'

/**
 * @internal
 * 数据库操作相关函数集合
 */
export const database = {
  /**
   * 初始化数据库模型
   * @param ctx Koishi 上下文对象
   * @param enableDaily 是否启用每日统计功能，默认为 false
   */
  initialize(ctx: Context, enableDaily: boolean = false) {
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
      ctx.model.extend('analytics.daily', {
        statId: 'unsigned',
        date: 'string',
        hour: { type: 'unsigned', nullable: true },
        count: 'unsigned',
      }, {
        primary: ['statId', 'date', 'hour'],
      })
    }
  },

  /**
   * 保存统计记录到数据库
   * @param ctx Koishi 上下文对象
   * @param data 需要保存的统计记录数据
   * @param increment 增量值，默认为 1
   * @returns Promise<void>
   */
  async saveRecord(ctx: Context, data: Partial<StatRecord>, increment: number = 1) {
    if (!data.command) data.command = '_message';
    if (data.guildId?.includes('private')) return;
    try {
      const query = {
        platform: data.platform,
        guildId: data.guildId,
        userId: data.userId,
        command: data.command
      };
      const normalized = Utils.normalizeRecord(data, { sanitizeNames: true });
      const [existing] = await ctx.database.get('analytics.stat', query);
      if (existing) {
        // 只更新有变化的部分
        const needUpdate = increment > 0 ||
          normalized.userName !== existing.userName ||
          normalized.guildName !== existing.guildName;
        if (needUpdate) {
          const updateData: Partial<StatRecord> = { lastTime: new Date() };
          if (increment > 0) updateData.count = existing.count + increment;
          if (normalized.userName !== existing.userName) updateData.userName = normalized.userName;
          if (normalized.guildName !== existing.guildName) updateData.guildName = normalized.guildName;
          await ctx.database.set('analytics.stat', query, updateData);
        }
      } else {
        await ctx.database.create('analytics.stat', {
          ...query,
          userName: normalized.userName,
          guildName: normalized.guildName,
          count: Math.max(1, increment),
          lastTime: new Date()
        });
      }
    } catch (e) {
      ctx.logger.error('保存记录失败:', e, data);
    }
  },

  /**
   * 保存每日统计记录到数据库
   * @param ctx Koishi 上下文对象
   * @param records 每日记录 Map 集合
   * @param date 日期字符串，格式 'YYYY-MM-DD'
   * @param hour 小时数（可选），用于按小时统计
   * @returns Promise 包含保存成功的记录数量
   */
  async saveDailyRecords(
    ctx: Context,
    records: Map<string, DailyRecord>,
    date: string,
    hour?: number | null
  ): Promise<{ savedCount: number }> {
    let savedCount = 0;
    const hourValue = hour !== undefined && hour !== null ? hour : null;
    try {
      for (const record of records.values()) {
        const [statRecord] = await ctx.database.get('analytics.stat', {
          platform: record.platform,
          guildId: record.guildId,
          userId: record.userId,
          command: '_message'
        }).catch(() => [null]);
        if (!statRecord?.id) {
          ctx.logger.warn(`未找到匹配的统计记录: ${record.platform}:${record.guildId}:${record.userId}`);
          continue;
        }
        const query = {
          statId: statRecord.id,
          date,
          hour: hourValue
        };
        const [existing] = await ctx.database.get('analytics.daily', query).catch(() => [null]);
        if (!existing || record.count > existing.count) {
          if (existing) {
            await ctx.database.set('analytics.daily', query, { count: record.count });
          } else {
            await ctx.database.create('analytics.daily', {
              ...query,
              count: record.count
            });
          }
          savedCount++;
        }
      }
    } catch (e) {
      ctx.logger.error('批量保存日常统计记录失败:', e);
    }
    return { savedCount };
  },

  /**
   * 注册清除统计数据的命令
   * @param ctx Koishi 上下文对象
   * @param parent 父命令对象，用于挂载子命令
   * @returns void
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
        // 无条件全部清除
        if (!options.below && !options.time &&
            !options.user && !options.platform &&
            !options.guild && !options.command) {
          await ctx.database.drop('analytics.stat');
          await this.initialize(ctx);
          return '已删除所有统计记录';
        }
        // 构建查询条件
        const query: any = {};
        if (options.user) query.userId = options.user;
        if (options.platform) query.platform = options.platform;
        if (options.guild) query.guildId = options.guild;
        if (options.command) query.command = options.command;
        if (options.below > 0) query.count = { $lt: options.below };
        if (options.time > 0) {
          const cutoffDate = new Date();
          cutoffDate.setDate(cutoffDate.getDate() - options.time);
          query.lastTime = { $lt: cutoffDate };
        }
        // 获取名称信息
        let userName = '', guildName = '';
        if (options.user) {
          const [userRecord] = await ctx.database.get('analytics.stat', { userId: options.user }, ['userName']);
          userName = userRecord?.userName || '';
        }
        if (options.guild) {
          const [guildRecord] = await ctx.database.get('analytics.stat', { guildId: options.guild }, ['guildName']);
          guildName = guildRecord?.guildName || '';
        }
        // 执行删除操作
        const recordsToDelete = await ctx.database.get('analytics.stat', query, ['id']);
        await ctx.database.remove('analytics.stat', query);
        // 构建返回消息
        const conditions = Utils.buildConditions({
          user: options.user ? (userName || options.user) : null,
          guild: options.guild ? (guildName || options.guild) : null,
          platform: options.platform,
          command: options.command
        });
        const thresholds = [
          options.below > 0 && `少于${options.below}次`,
          options.time > 0 && `在${options.time}天前`
        ].filter(Boolean);
        return `已删除${conditions.length ? conditions.join('、') + '的' : '所有'}${
          thresholds.length ? thresholds.join('且') + '的' : ''
        }统计记录（共${recordsToDelete.length}条）`;
      })
  }
}