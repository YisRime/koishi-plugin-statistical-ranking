import { Context, Schema, Session, h } from 'koishi'
import { Database } from './database'
import { io } from './io'
import { Utils } from './utils'
import { Stat } from './stat'
import { Renderer } from './render'
import { Rank } from './rank'

export const name = 'statistical-ranking'
export const inject = { required: ['database'], optional: ['puppeteer', 'cron'] }

export const usage = `
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #4a6ee0;">📌 插件说明</h2>
  <p>📖 <strong>使用文档</strong>：请点击左上角的 <strong>插件主页</strong> 查看插件使用文档</p>
  <p>🔍 <strong>更多插件</strong>：可访问 <a href="https://github.com/YisRime" style="color:#4a6ee0;text-decoration:none;">苡淞的 GitHub</a> 查看本人的所有插件</p>
</div>

<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #e0574a;">❤️ 支持与反馈</h2>
  <p>🌟 喜欢这个插件？请在 <a href="https://github.com/YisRime" style="color:#e0574a;text-decoration:none;">GitHub</a> 上给我一个 Star！</p>
  <p>🐛 遇到问题？请通过 <strong>Issues</strong> 提交反馈，或加入 QQ 群 <a href="https://qm.qq.com/q/PdLMx9Jowq" style="color:#e0574a;text-decoration:none;"><strong>855571375</strong></a> 进行交流</p>
</div>
`

/**
 * 插件配置接口
 * @interface Config
 */
export interface Config {
  /** 是否启用数据导入导出功能 */
  enableDataTransfer?: boolean
  /** 显示黑名单，不在默认展示中显示的项目 */
  displayBlacklist?: string[]
  /** 显示白名单，仅展示列表中的项目 */
  displayWhitelist?: string[]
  /** 是否默认使用图片模式输出 */
  defaultImageMode?: boolean
  /** 是否启用排行榜功能 */
  enableRank?: boolean
  /** 排行榜数据更新频率 */
  updateInterval?: string
}

// 插件配置模式
export const Config = Schema.intersect([
  Schema.object({
    defaultImageMode: Schema.boolean().default(false).description('默认输出图片'),
    enableDataTransfer: Schema.boolean().default(true).description('启用导入导出'),
    enableRank: Schema.boolean().default(false).description('启用发言排行'),
  }).description('基础配置'),
  Schema.union([
    Schema.object({
      enableRank: Schema.const(true).required(),
      updateInterval: Schema.union([
        Schema.const('hourly').description('每小时'),
        Schema.const('6h').description('每6小时'),
        Schema.const('12h').description('每12小时'),
        Schema.const('daily').description('每天')
      ]).default('daily').description('数据更新频率')
    }),
    Schema.object({}),
  ]),
  Schema.object({
    displayWhitelist: Schema.array(Schema.string()).description('白名单（仅展示以下记录）').default([]),
    displayBlacklist: Schema.array(Schema.string()).description('黑名单（不默认展示以下记录）').default(['qq:1234:5678', '.message']),
  }).description('展示配置')
])

// 数据表声明
declare module 'koishi' {
  interface Tables {
    'analytics.stat': StatRecord
    'analytics.rank': RankRecord
    'analytics.command': LegacyCommandRecord
    binding: BindingRecord
  }
}

/**
 * 排行榜记录数据结构
 * @interface RankRecord
 */
export interface RankRecord {
  /** 记录ID */
  id: number
  /** 统计项ID */
  stat: number
  /** 记录时间戳 */
  timestamp: Date
  /** 数量统计 */
  count: number
  /** 当前排名 */
  rank: number
}

/**
 * 统计记录数据结构
 * @interface StatRecord
 */
export interface StatRecord {
  /** 记录ID */
  id?: number
  /** 平台标识 */
  platform: string
  /** 群组ID */
  guildId: string
  /** 用户ID */
  userId: string
  /** 用户名称 */
  userName?: string
  /** 命令或操作标识 */
  command: string
  /** 计数 */
  count: number
  /** 最后记录时间 */
  lastTime: Date
  /** 群组名称 */
  guildName?: string
}

/**
 * 历史命令记录结构
 * @interface LegacyCommandRecord
 */
interface LegacyCommandRecord {
  /** 命令名称 */
  name: string
  /** 用户ID */
  userId: string
  /** 频道ID */
  channelId: string
  /** 平台标识 */
  platform?: string
  /** 日期 */
  date: number
  /** 小时 */
  hour: number
  /** 计数 */
  count: number
}

/**
 * 用户绑定记录结构
 * @interface BindingRecord
 */
interface BindingRecord {
  /** 平台ID */
  pid: string
  /** 平台标识 */
  platform: string
  /** 关联ID A */
  aid: number
  /** 关联ID B */
  bid: number
}

/**
 * 插件主函数
 * @param ctx - Koishi 上下文
 * @param config - 插件配置
 */
export async function apply(ctx: Context, config: Config = {}) {
  // 初始化配置
  config = {
    enableDataTransfer: true,
    defaultImageMode: false,
    displayWhitelist: [],
    displayBlacklist: [],
    enableRank: true,
    updateInterval: 'daily',
    ...config
  }
  Database.initialize(ctx)

  // 初始化排行榜功能
  let rank: Rank | null = null
  if (config.enableRank && ctx.cron) {
    rank = new Rank(ctx, {
      updateInterval: config.updateInterval,
      defaultImageMode: config.defaultImageMode
    })
    await rank.initialize()
  }

  /**
   * 处理消息和命令记录
   * @param session - 会话对象
   * @param command - 命令名称，为空时表示普通消息
   */
  const handleRecord = async (session: any, command?: string) => {
    const info = await Utils.getSessionInfo(session)
    if (!info) return
    const commandValue = command || '_message'
    await Database.saveRecord(ctx, { ...info, command: commandValue })
  }

  ctx.on('command/before-execute', ({session, command}) => handleRecord(session, command.name))
  ctx.on('message', (session) => handleRecord(session, null))

  /**
   * 尝试渲染图片并发送
   * @param session - 会话对象
   * @param renderFn - 渲染函数，接收渲染器并返回图片缓冲区或缓冲区数组
   * @returns 是否成功渲染并发送图片
   */
  async function tryRenderImage(
    session: Session<never, never>,
    renderFn: (renderer: Renderer) => Promise<Buffer | Buffer[]>
  ): Promise<boolean> {
    if (!ctx.puppeteer) return false
    try {
      const renderer = new Renderer(ctx)
      const result = await renderFn(renderer)
      if (Array.isArray(result)) {
        for (const buffer of result) {
          await session.send(h.image(buffer, 'image/png'))
        }
      } else {
        await session.send(h.image(result, 'image/png'))
      }
      return true
    } catch (e) {
      ctx.logger.error('图片渲染失败', e)
      return false
    }
  }

  const stat = ctx.command('stat [arg:string]', '查看统计信息')
    .option('visual', '-v 切换可视化模式')
    .option('sort', '-s [method:string] 排序方式', { fallback: 'count' })
    .option('user', '-u [userId:string] 指定用户', { authority: 2 })
    .action(async ({ session, args, options }) => {
      // 获取用户信息和解析参数
      const currentUser = await Utils.getSessionInfo(session)
      const arg = args[0]?.toLowerCase()
      let page = arg && /^\d+$/.test(arg) ? parseInt(arg) : 1
      const showAll = arg === 'all'
      // 确定要查询的用户ID
      const targetUserId = options.user || currentUser.userId
      const targetPlatform = options.user ? undefined : currentUser.platform
      // 获取命令统计和群组统计
      const [commandResult, messageResult] = await Promise.all([
        Stat.handleStatQuery(ctx, { user: targetUserId, platform: targetPlatform }, 'command'),
        Stat.handleStatQuery(ctx, { user: targetUserId, platform: targetPlatform, command: '_message' }, 'guild')
      ]);
      // 计算消息总数和处理数据
      let totalMessages = 0;
      if (typeof messageResult !== 'string') {
        totalMessages = messageResult.records.reduce((sum, record) => sum + record.count, 0);
      }
      const allItems = [];
      const sortBy = options.sort === 'time' ? 'time' : (options.sort === 'key' ? 'key' : 'count');
      // 处理命令统计
      if (typeof commandResult !== 'string' && commandResult.records.length > 0) {
        const processedCommands = await Stat.processStatRecords(commandResult.records, 'command', {
          sortBy, disableCommandMerge: false, skipPaging: true, title: '命令统计'
        });
        allItems.push(...processedCommands.items.map(item => ({ type: 'command', content: item })));
      }
      // 处理群组统计
      if (typeof messageResult !== 'string' && messageResult.records.length > 0) {
        const processedGroups = await Stat.processStatRecords(messageResult.records, 'guildId', {
          sortBy, truncateId: true, skipPaging: true, title: '群组统计'
        });
        allItems.push(...processedGroups.items.map(item => ({ type: 'guild', content: item })));
      }
      // 分页处理
      const pageSize = 8;
      const totalPages = Math.ceil(allItems.length / pageSize) || 1;
      const validPage = Math.min(Math.max(1, page), totalPages);
      const startIdx = showAll ? 0 : (validPage - 1) * pageSize;
      const endIdx = showAll ? allItems.length : Math.min(startIdx + pageSize, allItems.length);
      const pagedItems = allItems.slice(startIdx, endIdx);
      // 确定显示名称
      let displayName = currentUser.userName || currentUser.userId;
      if (options.user) {
        const records = [...(typeof messageResult !== 'string' ? messageResult.records : []),
                         ...(typeof commandResult !== 'string' ? commandResult.records : [])];
        const userRecord = records.find(r => r.userId === options.user && r.userName);
        displayName = userRecord?.userName || options.user;
      }
      // 生成标题和获取渲染内容
      const pageInfo = (showAll || totalPages <= 1) ? '' : `（第${validPage}/${totalPages}页）`;
      const title = `${displayName}的统计（共${totalMessages}条）${pageInfo} ——`;
      const items = pagedItems.map(item => item.content);
      // 确定渲染模式并输出
      const useImageMode = options.visual ? !config.defaultImageMode : config.defaultImageMode;
      if (useImageMode) {
        const renderSuccess = await tryRenderImage(session, async (renderer) => {
          const datasets = [];
          if (typeof commandResult !== 'string' && commandResult.records.length > 0) {
            datasets.push({
              records: commandResult.records,
              title: '命令统计',
              key: 'command',
              options: { sortBy, limit: 15, truncateId: false }
            });
          }
          if (typeof messageResult !== 'string' && messageResult.records.length > 0) {
            datasets.push({
              records: messageResult.records,
              title: '发言统计',
              key: 'guildId',
              options: { sortBy, limit: 15, truncateId: true }
            });
          }
          return await renderer.generateCombinedStatImage(datasets, `${displayName}的统计`);
        });
        if (renderSuccess) return;
      }
      // 文本模式输出
      return title + '\n' + items.join('\n');
    })

  /**
   * 统一处理子命令的公共配置
   * @param cmd - 命令对象
   * @param title - 统计标题
   * @param keyField - 要统计的键字段
   * @param truncateId - 是否截断ID显示
   * @returns 命令处理结果
   */
  const configureStatSubcommand = (cmd, title, keyField, truncateId = false) => {
    return cmd.action(async ({options, args, session}) => {
      const arg = args[0]?.toLowerCase();
      let page = 1;
      let showAll = false;
      if (arg === 'all') showAll = true;
      else if (arg && /^\d+$/.test(arg)) page = parseInt(arg);
      // 设置默认选项
      if (!options.guild && !options.all && session.guildId && keyField !== 'guildId') {
        options.guild = session.guildId;
      }
      // 私聊场景处理
      if (!session.guildId && !options.guild && !options.user && !options.platform) {
        options.all = true;
      }
      const result = await Stat.handleStatQuery(ctx, options, keyField === 'guildId' ? 'guild' : keyField);
      if (typeof result === 'string') return result;
      // 获取排序方式
      const sortBy = options.sort === 'time' ? 'time' : (options.sort === 'key' ? 'key' : 'count');
      const useImageMode = options.visual ? !config.defaultImageMode : config.defaultImageMode;
      // 图片渲染逻辑
      if (useImageMode) {
        const renderSuccess = await tryRenderImage(session, async (renderer) => {
          return await renderer.generateStatImage(
            result.records,
            keyField,
            result.title.replace(' ——', ''),
            {
              sortBy,
              truncateId,
              disableCommandMerge: keyField === 'command' && showAll,
              displayBlacklist: showAll ? [] : config.displayBlacklist,
              displayWhitelist: showAll ? [] : config.displayWhitelist,
              limit: 15,
            }
          );
        });
        if (renderSuccess) return;
      }
      // 文本处理逻辑
      const processed = await Stat.processStatRecords(result.records, keyField, {
        sortBy,
        truncateId,
        disableCommandMerge: keyField === 'command' && showAll,
        displayBlacklist: showAll ? [] : config.displayBlacklist,
        displayWhitelist: showAll ? [] : config.displayWhitelist,
        page: page,
        pageSize: 15,
        title: result.title,
        skipPaging: showAll
      });
      return processed.title + '\n' + processed.items.join('\n');
    });
  };

  // 命令统计子命令
  stat.subcommand('.command [arg:string]', '查看命令统计')
    .option('user', '-u [user:string] 指定用户统计')
    .option('guild', '-g [guild:string] 指定群组统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .option('visual', '-v 切换可视化模式')
    .option('all', '-a 显示全局统计')
    .option('sort', '-s [method:string] 排序方式', { fallback: 'count' })
    .action(async (payload) => configureStatSubcommand({...payload, options: {...payload.options}},
      '命令统计', 'command', false));
  // 用户统计子命令
  stat.subcommand('.user [arg:string]', '查看发言统计')
    .option('guild', '-g [guild:string] 指定群组统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .option('visual', '-v 切换可视化模式')
    .option('all', '-a 显示全局统计')
    .option('sort', '-s [method:string] 排序方式', { fallback: 'count' })
    .action(async (payload) => configureStatSubcommand({...payload, options: {...payload.options}},
      '用户统计', 'userId', true));
  // 群组统计子命令
  stat.subcommand('.guild [arg:string]', '查看群组统计', { authority: 2 })
    .option('user', '-u [user:string] 指定用户统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .option('command', '-c [command:string] 指定命令统计')
    .option('visual', '-v 切换可视化模式')
    .option('sort', '-s [method:string] 排序方式', { fallback: 'count' })
    .action(async (payload) => configureStatSubcommand({...payload, options: {...payload.options}},
      '群组统计', 'guildId', true));

  // 注册其他命令
  Stat.registerListCommand(ctx, stat)
  Database.registerClearCommand(ctx, stat)

  if (config.enableRank && rank) {
    rank.registerRankCommands(stat)
  }
  if (config.enableDataTransfer) {
    io.registerCommands(ctx, stat)
  }
}