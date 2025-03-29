import { Context, Schema, Session, h } from 'koishi'
import { database } from './database'
import { io } from './io'
import { Utils } from './utils'
import { statProcessor } from './stat'
import { Renderer } from './render'

/**
 * @packageDocumentation
 * 统计与排名插件 - 用于统计和分析用户命令使用情况与活跃度
 */
export const name = 'statistical-ranking'
export const inject = {
  required: ['database'],
  optional: ['puppeteer']
}

/**
 * 插件配置接口
 * @interface Config
 * @property {boolean} [enableDataTransfer] - 是否启用数据导入导出功能
 * @property {string[]} [displayBlacklist] - 显示过滤黑名单
 * @property {string[]} [displayWhitelist] - 显示过滤白名单
 * @property {boolean} [defaultImageMode] - 是否默认使用图片模式展示
 * @property {boolean} [silentMode] - 是否启用静默模式
 * @property {string[]} [allowedGuilds] - 静默模式下允许响应的群组列表
 */
export interface Config {
  enableDataTransfer?: boolean
  displayBlacklist?: string[]
  displayWhitelist?: string[]
  defaultImageMode?: boolean
  silentMode?: boolean
  allowedGuilds?: string[]
}

/**
 * 插件配置模式
 */
export const Config = Schema.intersect([
  Schema.object({
    enableDataTransfer: Schema.boolean().default(true).description('启用导入导出'),
    defaultImageMode: Schema.boolean().default(false).description('默认以图片输出'),
    silentMode: Schema.boolean().default(false).description('静默模式'),
    displayWhitelist: Schema.array(Schema.string())
      .description('显示白名单：仅展示以下记录（优先级高于黑名单）')
      .default([]),
    displayBlacklist: Schema.array(Schema.string())
      .description('显示黑名单：不默认展示以下记录(platform:guild:user/.command)')
      .default([
        'qq:1234:5678',
        '.message',
      ]),
    allowedGuilds: Schema.array(Schema.string())
      .description('静默模式白名单群组ID')
      .default([]),
    }).description('统计配置'),
])

/**
 * Koishi 数据表声明
 */
declare module 'koishi' {
  interface Tables {
    'analytics.stat': StatRecord
    'analytics.command': LegacyCommandRecord
    binding: BindingRecord
  }
}

/**
 * 统计记录数据结构
 * @interface StatRecord
 * @description 记录用户在不同平台、群组中的命令使用和消息发送情况
 * @property {number} id - 记录的唯一ID（自增主键，导入导出时会自动忽略）
 * @property {string} platform - 平台标识(如 onebot、telegram 等)
 * @property {string} guildId - 群组/频道 ID，私聊时为 'private'
 * @property {string} userId - 用户在该平台的唯一标识
 * @property {string} [userName] - 用户昵称，可选
 * @property {string} command - 命令名称，普通消息时为 '_message'
 * @property {number} count - 记录次数，用于统计使用频率
 * @property {Date} lastTime - 最后一次记录的时间
 * @property {string} [guildName] - 群组/频道名称，可选
 */
export interface StatRecord {
  id?: number
  platform: string
  guildId: string
  userId: string
  userName?: string
  command: string
  count: number
  lastTime: Date
  guildName?: string
}

/**
 * 历史命令记录结构
 * @interface LegacyCommandRecord
 * @description 用于兼容旧版统计数据的结构
 */
interface LegacyCommandRecord {
  name: string
  userId: string
  channelId: string
  platform?: string
  date: number
  hour: number
  count: number
}

/**
 * 用户绑定记录结构
 * @interface BindingRecord
 * @description 存储用户跨平台账号绑定关系
 * @property {string} pid - 平台用户 ID
 * @property {string} platform - 平台标识
 * @property {number} aid - 关联账号 ID
 * @property {number} bid - 绑定记录 ID
 */
interface BindingRecord {
  pid: string
  platform: string
  aid: number
  bid: number
}

/**
 * 插件主函数
 * @public
 *
 * 初始化插件功能：
 * - 设置数据库结构
 * - 注册事件监听器
 * - 注册指令
 *
 * @param ctx - Koishi应用上下文
 * @param config - 插件配置对象
 */
export async function apply(ctx: Context, config: Config = {}) {

  config = {
    enableDataTransfer: true,
    defaultImageMode: false,
    displayWhitelist: [],
    displayBlacklist: [],
    silentMode: false,
    allowedGuilds: [],
    ...config
  }
  database.initialize(ctx)

  /**
   * 处理消息和命令记录
   * @param {any} session - 会话对象
   * @param {string} [command] - 命令名称，为空时表示普通消息
   * @returns {Promise<void>}
   */
  const handleRecord = async (session: any, command?: string) => {
    const info = await Utils.getSessionInfo(session)
    if (!info) return

    const commandValue = command || '_message'
    await database.saveRecord(ctx, { ...info, command: commandValue })
  }

  ctx.on('command/before-execute', ({session, command}) => handleRecord(session, command.name))
  ctx.on('message', (session) => handleRecord(session, null))

  /**
   * 静默模式拦截器函数
   * @param {any} argv 命令参数
   * @returns {boolean|void} 是否终止命令执行
   */
  function silentModeInterceptor(argv) {
    if (!argv.session.guildId) return;
    if (config.allowedGuilds.includes(argv.session.guildId)) return;
    argv.session.terminate();
  }

  /**
   * 尝试渲染图片并发送
   * @param session 会话
   * @param renderFn 渲染函数
   * @returns 是否成功
   */
  async function tryRenderImage(
    session: Session<never, never>,
    renderFn: (renderer: Renderer) => Promise<Buffer | Buffer[]>
  ): Promise<boolean> {
    if (!ctx.puppeteer) {
      return false
    }

    try {
      const renderer = new Renderer(ctx)
      const result = await renderFn(renderer)

      if (Array.isArray(result)) {
        // 多页图片，依次发送
        for (const buffer of result) {
          await session.send(h.image(buffer, 'image/png'))
        }
      } else {
        // 单页图片，直接发送
        await session.send(h.image(result, 'image/png'))
      }
      return true
    } catch (e) {
      ctx.logger.error('图片渲染失败', e)
      await session.send(`图片渲染失败: ${e.message || '未知错误'}`)
      return false
    }
  }

  /**
   * 主统计命令
   * 用于查看用户的个人统计信息
   */
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
        // 命令统计查询
        statProcessor.handleStatQuery(ctx, {
          user: targetUserId,
          platform: targetPlatform
        }, 'command'),
        // 消息统计查询
        statProcessor.handleStatQuery(ctx, {
          user: targetUserId,
          platform: targetPlatform,
          command: '_message'
        }, 'guild')
      ]);
      // 计算消息总数
      let totalMessages = 0;
      if (typeof messageResult !== 'string') {
        totalMessages = messageResult.records.reduce((sum, record) => sum + record.count, 0);
      }
      const allItems = [];
      // 获取用户选择的排序方式
      const sortBy = options.sort === 'time' ? 'time' : (options.sort === 'key' ? 'key' : 'count');
      // 处理命令统计
      if (typeof commandResult !== 'string' && commandResult.records.length > 0) {
        const processedCommands = await statProcessor.processStatRecords(commandResult.records, 'command', {
          sortBy,
          disableCommandMerge: false,
          skipPaging: true,
          title: '命令统计'
        });
        allItems.push(...processedCommands.items.map(item => ({ type: 'command', content: item })));
      }
      // 处理群组统计
      if (typeof messageResult !== 'string' && messageResult.records.length > 0) {
        const processedGroups = await statProcessor.processStatRecords(messageResult.records, 'guildId', {
          sortBy,
          truncateId: true,
          skipPaging: true,
          title: '群组统计'
        });
        allItems.push(...processedGroups.items.map(item => ({ type: 'guild', content: item })));
      }
      // 计算分页
      const pageSize = 8;
      const totalPages = Math.ceil(allItems.length / pageSize) || 1;
      const validPage = Math.min(Math.max(1, page), totalPages);
      // 获取当前页数据
      const startIdx = showAll ? 0 : (validPage - 1) * pageSize;
      const endIdx = showAll ? allItems.length : Math.min(startIdx + pageSize, allItems.length);
      const pagedItems = allItems.slice(startIdx, endIdx);
      // 确定要显示的用户名
      let displayName = currentUser.userName || currentUser.userId;
      if (options.user) {
        // 如果指定了用户ID，尝试从结果中获取用户名
        if (typeof messageResult !== 'string' && messageResult.records.length > 0) {
          const userRecord = messageResult.records.find(r => r.userId === options.user && r.userName);
          if (userRecord?.userName) {
            displayName = userRecord.userName;
          } else {
            displayName = options.user;
          }
        } else if (typeof commandResult !== 'string' && commandResult.records.length > 0) {
          const userRecord = commandResult.records.find(r => r.userId === options.user && r.userName);
          if (userRecord?.userName) {
            displayName = userRecord.userName;
          } else {
            displayName = options.user;
          }
        } else {
          displayName = options.user;
        }
      }
      // 生成标题
      const pageInfo = (showAll || totalPages <= 1) ? '' : `（第${validPage}/${totalPages}页）`;
      const title = `${displayName}的统计（共${totalMessages}条）${pageInfo} ——`;
      // 获取渲染内容
      const items = pagedItems.map(item => item.content);
      // 确定模式
      const useImageMode = options.visual ? !config.defaultImageMode : config.defaultImageMode;
      // 图片模式
      if (useImageMode) {
        // 尝试渲染图片
        const renderSuccess = await tryRenderImage(session, async (renderer) => {
          // 准备数据集
          const datasets = [];
          // 加入命令统计数据
          if (typeof commandResult !== 'string' && commandResult.records.length > 0) {
            datasets.push({
              records: commandResult.records,
              title: '命令统计',
              key: 'command',
              options: {
                limit: 15,
                truncateId: false,
                sortBy
              }
            });
          }
          // 加入群组统计数据
          if (typeof messageResult !== 'string' && messageResult.records.length > 0) {
            datasets.push({
              records: messageResult.records,
              title: '发言统计',
              key: 'guildId',
              options: {
                limit: 15,
                truncateId: true,
                sortBy
              }
            });
          }
          // 生成综合统计图
          return await renderer.generateCombinedStatImage(
            datasets,
            `${displayName}的统计`
          );
        })

        if (renderSuccess) return
      }

      // 文本模式输出
      return title + '\n' + items.join('\n');
    })

  /**
   * 命令统计子命令
   * 用于查看特定命令的使用统计
   */
  const commandStat = stat.subcommand('.command [arg:string]', '查看命令统计')
    .option('user', '-u [user:string] 指定用户统计')
    .option('guild', '-g [guild:string] 指定群组统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .option('visual', '-v 切换可视化模式')
    .option('all', '-a 显示全局统计')
    .option('sort', '-s [method:string] 排序方式', { fallback: 'count' })
    .action(async ({options, args, session}) => {
      const arg = args[0]?.toLowerCase()
      let page = 1
      let showAll = false
      if (arg === 'all') {
        showAll = true
      } else if (arg && /^\d+$/.test(arg)) {
        page = parseInt(arg)
      }
      // 如果未指定群组选项且未指定全局选项，默认使用当前群组
      if (!options.guild && !options.all && session.guildId) {
        options.guild = session.guildId
      }
      // 如果在私聊中使用且未指定任何筛选条件，则显示全局统计
      if (!session.guildId && !options.guild && !options.user && !options.platform) {
        options.all = true
      }
      const result = await statProcessor.handleStatQuery(ctx, options, 'command')
      if (typeof result === 'string') return result
      // 获取用户选择的排序方式
      const sortBy = options.sort === 'time' ? 'time' : (options.sort === 'key' ? 'key' : 'count');
      const useImageMode = options.visual ? !config.defaultImageMode : config.defaultImageMode;
      // 图片渲染逻辑
      if (useImageMode) {
        const renderSuccess = await tryRenderImage(session, async (renderer) => {
          return await renderer.generateStatImage(
            result.records,
            'command',
            result.title.replace(' ——', ''),
            {
              sortBy,
              disableCommandMerge: showAll,
              displayBlacklist: showAll ? [] : config.displayBlacklist,
              displayWhitelist: showAll ? [] : config.displayWhitelist,
              limit: 15,
            }
          )
        })

        if (renderSuccess) return
      }

      const processed = await statProcessor.processStatRecords(result.records, 'command', {
        sortBy,
        disableCommandMerge: showAll,
        displayBlacklist: showAll ? [] : config.displayBlacklist,
        displayWhitelist: showAll ? [] : config.displayWhitelist,
        page: page,
        pageSize: 15,
        title: result.title,
        skipPaging: showAll
      })

      return processed.title + '\n' + processed.items.join('\n');
    })

  /**
   * 用户统计子命令
   * 用于查看特定用户的发言统计
   */
  const userStat = stat.subcommand('.user [arg:string]', '查看发言统计')
    .option('guild', '-g [guild:string] 指定群组统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .option('visual', '-v 切换可视化模式')
    .option('all', '-a 显示全局统计')
    .option('sort', '-s [method:string] 排序方式', { fallback: 'count' })
    .action(async ({options, args, session}) => {
      const arg = args[0]?.toLowerCase()
      let page = 1
      let showAll = false
      if (arg === 'all') {
        showAll = true
      } else if (arg && /^\d+$/.test(arg)) {
        page = parseInt(arg)
      }
      // 如果未指定群组选项且未指定全局选项，默认使用当前群组
      if (!options.guild && !options.all && session.guildId) {
        options.guild = session.guildId
      }
      // 如果在私聊中使用且未指定任何筛选条件，则显示全局统计
      if (!session.guildId && !options.guild && !options.platform) {
        options.all = true
      }
      const result = await statProcessor.handleStatQuery(ctx, options, 'user')
      if (typeof result === 'string') return result
      // 获取用户选择的排序方式
      const sortBy = options.sort === 'time' ? 'time' : (options.sort === 'key' ? 'key' : 'count');
      const useImageMode = options.visual ? !config.defaultImageMode : config.defaultImageMode;
      // 图片渲染逻辑
      if (useImageMode) {
        const renderSuccess = await tryRenderImage(session, async (renderer) => {
          return await renderer.generateStatImage(
            result.records,
            'userId',
            result.title.replace(' ——', ''),
            {
              sortBy,
              truncateId: true,
              displayBlacklist: showAll ? [] : config.displayBlacklist,
              displayWhitelist: showAll ? [] : config.displayWhitelist,
              limit: 15,
            }
          )
        })

        if (renderSuccess) return
      }

      const processed = await statProcessor.processStatRecords(result.records, 'userId', {
        sortBy,
        truncateId: true,
        displayBlacklist: showAll ? [] : config.displayBlacklist,
        displayWhitelist: showAll ? [] : config.displayWhitelist,
        page: page,
        pageSize: 15,
        title: result.title,
        skipPaging: showAll
      })

      return processed.title + '\n' + processed.items.join('\n');
    })

  /**
   * 群组统计子命令
   * 用于查看特定群组的发言统计
   */
  stat.subcommand('.guild [arg:string]', '查看群组统计', { authority: 2 })
    .option('user', '-u [user:string] 指定用户统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .option('command', '-c [command:string] 指定命令统计')
    .option('visual', '-v 切换可视化模式')
    .option('sort', '-s [method:string] 排序方式', { fallback: 'count' })
    .action(async ({options, args, session}) => {
      const arg = args[0]?.toLowerCase()
      let page = 1
      let showAll = false
      if (arg === 'all') {
        showAll = true
      } else if (arg && /^\d+$/.test(arg)) {
        page = parseInt(arg)
      }

      const result = await statProcessor.handleStatQuery(ctx, options, 'guild')
      if (typeof result === 'string') return result
      // 获取用户选择的排序方式
      const sortBy = options.sort === 'time' ? 'time' : (options.sort === 'key' ? 'key' : 'count');
      const useImageMode = options.visual ? !config.defaultImageMode : config.defaultImageMode;
      // 图片渲染逻辑
      if (useImageMode) {
        const renderSuccess = await tryRenderImage(session, async (renderer) => {
          return await renderer.generateStatImage(
            result.records,
            'guildId',
            result.title.replace(' ——', ''),
            {
              sortBy,
              truncateId: true,
              displayBlacklist: showAll ? [] : config.displayBlacklist,
              displayWhitelist: showAll ? [] : config.displayWhitelist,
              limit: 15,
            }
          )
        })

        if (renderSuccess) return
      }

      const processed = await statProcessor.processStatRecords(result.records, 'guildId', {
        sortBy,
        truncateId: true,
        displayBlacklist: showAll ? [] : config.displayBlacklist,
        displayWhitelist: showAll ? [] : config.displayWhitelist,
        page: page,
        pageSize: 15,
        title: result.title,
        skipPaging: showAll
      })

      return processed.title + '\n' + processed.items.join('\n');
    })

  statProcessor.registerListCommand(ctx, stat)
  database.registerClearCommand(ctx, stat)

  if (config.enableDataTransfer) {
    io.registerCommands(ctx, stat)
  }

  if (config.silentMode) {
    stat.before(silentModeInterceptor)
    commandStat.before(silentModeInterceptor)
    userStat.before(silentModeInterceptor)
  }
}