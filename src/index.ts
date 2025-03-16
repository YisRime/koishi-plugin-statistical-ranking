import { Context, Schema } from 'koishi'
import { database } from './database'
import { io } from './io'
import { utils } from './utils'

/**
 * @packageDocumentation
 * 统计与排名插件 - 用于统计和分析用户命令使用情况与活跃度
 */
export const name = 'statistical-ranking'
export const inject = ['database']

/**
 * 插件配置接口
 * @interface Config
 * @property {boolean} [enableDataTransfer] - 是否启用数据导入导出功能
 * @property {boolean} [enableClear] - 是否启用数据清除功能
 * @property {boolean} [enableDisplayFilter] - 是否启用显示过滤功能
 * @property {string[]} [displayBlacklist] - 显示过滤黑名单
 * @property {string[]} [displayWhitelist] - 显示过滤白名单
 */
export interface Config {
  enableDataTransfer?: boolean
  enableClear?: boolean
  enableDisplayFilter?: boolean
  displayBlacklist?: string[]
  displayWhitelist?: string[]
}

/**
 * 插件配置模式
 */
export const Config = Schema.intersect([
  Schema.object({
    enableClear: Schema.boolean().default(true).description('启用统计数据清除'),
    enableDataTransfer: Schema.boolean().default(true).description('启用统计数据导入导出'),
    enableDisplayFilter: Schema.boolean().default(false).description('启用显示过滤'),
  }).description('基础配置'),
  Schema.union([
    Schema.object({
      enableDisplayFilter: Schema.const(true).required(),
      displayWhitelist: Schema.array(Schema.string())
        .description('显示白名单，仅展示这些统计记录（先于黑名单生效）')
        .default([]),
      displayBlacklist: Schema.array(Schema.string())
        .description('显示黑名单，将不会默认展示以下命令/用户/群组/平台')
        .default([
          'onebot:12345:67890',
          'qq::12345',
          'sandbox::',
          '.help',
        ]),
    }),
    Schema.object({}),
  ]),
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
export async function apply(ctx: Context, config: Config) {
  database.initialize(ctx)
  const handleRecord = async (session: any, command?: string) => {
    const info = await utils.getSessionInfo(session)
    if (!info) return

    const commandValue = command || '_message'
    await database.saveRecord(ctx, { ...info, command: commandValue })
  }

  ctx.on('command/before-execute', ({session, command}) => handleRecord(session, command.name))
  ctx.on('message', (session) => handleRecord(session, null))

  const stat = ctx.command('stat [arg:string]', '查看个人统计信息')
    .action(async ({ session, args }) => {
      // 获取用户完整信息
      const userInfo = await utils.getSessionInfo(session)
      const options = { userId: userInfo.userId, platform: userInfo.platform }
      const records = await ctx.database.get('analytics.stat', options)
      if (!records?.length) return '未找到记录'
      // 解析参数
      const arg = args[0]?.toLowerCase()
      let page = 1
      let showAll = false
      if (arg === 'all') {
        showAll = true
      } else if (arg && /^\d+$/.test(arg)) {
        page = parseInt(arg)
      }
      // 分类记录
      const messageRecords = records.filter(r => r.command === '_message')
      const commandRecords = records.filter(r => r.command !== '_message')
      const totalMessages = messageRecords.reduce((sum, r) => sum + r.count, 0)
      // 生成标题
      const title = `${userInfo.userName || userInfo.userId}的统计（总计${totalMessages}条） —`
      // 命令统计部分
      const commandResult = await utils.processStatRecords(commandRecords, 'command', {
        sortBy: 'count',
        disableCommandMerge: false,
        skipPaging: showAll,
        page: page,
        pageSize: 8,
      })
      // 群组统计部分
      const guildResult = await utils.processStatRecords(messageRecords, 'guildId', {
        sortBy: 'count',
        truncateId: true,
        skipPaging: showAll,
        page: page,
        pageSize: 8,
      })
      // 格式化输出
      let result = `${title}\n`
      if (commandResult.items.length > 0) {
        result += `\n${commandResult.title}\n${commandResult.items.join('\n')}\n`
      }
      if (guildResult.items.length > 0) {
        result += `\n${guildResult.title}\n${guildResult.items.join('\n')}`
      }

      return result
    })

  stat.subcommand('.command [arg:string]', '查看命令统计')
    .option('user', '-u [user:string] 指定用户统计')
    .option('guild', '-g [guild:string] 指定群组统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .action(async ({options, args}) => {
      const arg = args[0]?.toLowerCase()
      let page = 1
      let showAll = false
      if (arg === 'all') {
        showAll = true
      } else if (arg && /^\d+$/.test(arg)) {
        page = parseInt(arg)
      }

      const result = await utils.handleStatQuery(ctx, options, 'command')
      if (typeof result === 'string') return result
      const processed = await utils.processStatRecords(result.records, 'command', {
        sortBy: 'count',
        disableCommandMerge: showAll,
        displayBlacklist: showAll ? [] : (config.enableDisplayFilter ? config.displayBlacklist : []),
        displayWhitelist: showAll ? [] : (config.enableDisplayFilter ? config.displayWhitelist : []),
        page: page,
        pageSize: 15,
        title: result.title,
        skipPaging: showAll
      })

      return processed.title + '\n' + processed.items.join('\n')
    })

  stat.subcommand('.user [arg:string]', '查看发言统计')
    .option('guild', '-g [guild:string] 指定群组统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .action(async ({options, args}) => {
      const arg = args[0]?.toLowerCase()
      let page = 1
      let showAll = false
      if (arg === 'all') {
        showAll = true
      } else if (arg && /^\d+$/.test(arg)) {
        page = parseInt(arg)
      }

      const result = await utils.handleStatQuery(ctx, options, 'user')
      if (typeof result === 'string') return result
      const processed = await utils.processStatRecords(result.records, 'userId', {
        sortBy: 'count',
        truncateId: true,
        displayBlacklist: showAll ? [] : (config.enableDisplayFilter ? config.displayBlacklist : []),
        displayWhitelist: showAll ? [] : (config.enableDisplayFilter ? config.displayWhitelist : []),
        page: page,
        pageSize: 15,
        title: result.title,
        skipPaging: showAll
      })

      return processed.title + '\n' + processed.items.join('\n')
    })

  stat.subcommand('.guild [arg:string]', '查看群组统计')
    .option('user', '-u [user:string] 指定用户统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .option('command', '-c [command:string] 指定命令统计')
    .action(async ({options, args}) => {
      const arg = args[0]?.toLowerCase()
      let page = 1
      let showAll = false
      if (arg === 'all') {
        showAll = true
      } else if (arg && /^\d+$/.test(arg)) {
        page = parseInt(arg)
      }

      const result = await utils.handleStatQuery(ctx, options, 'guild')
      if (typeof result === 'string') return result
      const processed = await utils.processStatRecords(result.records, 'guildId', {
        sortBy: 'count',
        truncateId: true,
        displayBlacklist: showAll ? [] : (config.enableDisplayFilter ? config.displayBlacklist : []),
        displayWhitelist: showAll ? [] : (config.enableDisplayFilter ? config.displayWhitelist : []),
        page: page,
        pageSize: 15,
        title: result.title,
        skipPaging: showAll
      })

      return processed.title + '\n' + processed.items.join('\n')
    })

  stat.subcommand('.list', '查看类型列表', { authority: 3 })
    .option('user', '-u 显示用户列表')
    .option('guild', '-g 显示群组列表')
    .action(async ({ options }) => {
      const records = await ctx.database.get('analytics.stat', {})
      if (!records?.length) return '未找到记录'

      const formatList = (key: keyof StatRecord, title: string) => {
        const uniqueKeys = utils.getUniqueKeys(records, key)

        if (key === 'command') {
          const commands = uniqueKeys.filter(cmd => cmd !== '_message')
          return commands.length ? `${title} ——\n${commands.join(', ')}` : null
        } else if (key === 'userId' || key === 'guildId') {
          const items = uniqueKeys.map(id => {
            const record = records.find(r => r[key] === id)
            const name = key === 'userId' ? record?.userName : record?.guildName
            return name ? `${name} (${id})` : id
          })
          return items.length ? `${title} ——\n${items.join(', ')}` : null
        }

        return uniqueKeys.length ? `${title} ——\n${uniqueKeys.join(', ')}` : null
      }

      const hasParams = options.user || options.guild
      const parts: (string | null)[] = []

      if (!hasParams) {
        parts.push(formatList('platform', '平台列表'))
        parts.push(formatList('command', '命令列表'))
      }
      if (options.user) parts.push(formatList('userId', '用户列表'))
      if (options.guild) parts.push(formatList('guildId', '群组列表'))

      return parts.filter(Boolean).join('\n')
    })

  if (config.enableClear) {
    stat.subcommand('.clear', '清除统计数据', { authority: 4 })
      .option('user', '-u [user:string] 指定用户')
      .option('platform', '-p [platform:string] 指定平台')
      .option('guild', '-g [guild:string] 指定群组')
      .option('command', '-c [command:string] 指定命令')
      .action(async ({ options }) => {
        const result = await database.clearStats(ctx, {
          userId: options.user,
          platform: options.platform,
          guildId: options.guild,
          command: options.command
        })

        if (result === -1) return '已删除所有统计记录'
        const conditions = Object.entries({
          user: ['用户', options.user],
          guild: ['群组', options.guild],
          platform: ['平台', options.platform],
          command: ['命令', options.command]
        })
          .filter(([_, [__, value]]) => value)
          .map(([_, [label, value]]) => `${label}${value}`)

        return conditions.length
          ? `已删除${conditions.join('、')}的统计记录`
          : `已删除所有统计记录`
      })
  }

  if (config.enableDataTransfer) {
    stat.subcommand('.export', '导出统计数据', { authority: 4 })
      .option('user', '-u [user:string] 指定用户')
      .option('platform', '-p [platform:string] 指定平台')
      .option('guild', '-g [guild:string] 指定群组')
      .option('command', '-c [command:string] 指定命令')
      .action(async ({ options, session }) => {
        try {
          if (Object.values(options).some(Boolean)) {
            await session.send('正在导出...')
          }

          const result = await io.exportToFile(ctx, 'stat', {
            userId: options.user,
            platform: options.platform,
            guildId: options.guild,
            command: options.command
          })

          if (result.batches === 1) {
            return `导出成功（${result.count}条）：\n- ${result.files[0].filename}`
          } else {
            const fileList = result.files.map(f => `- ${f.filename}`).join('\n')
            return `导出成功（${result.count}条）：\n${fileList}`
          }
        } catch (e) {
          return `导出失败：${e.message}`
        }
      })

    stat.subcommand('.import [selector:number]', '导入统计数据', { authority: 4 })
      .option('force', '-f 覆盖现有数据')
      .option('database', '-d 从历史数据库导入')
      .action(async ({ session, options, args }) => {
        try {
          // 从历史数据库导入
          if (options.database) {
            session.send('正在导入历史记录...')
            try {
              const result = await io.importLegacyData(ctx, options.force)
              return result
            } catch (e) {
              return e.message
            }
          }
          // 获取可导入文件列表
          const { files, fileInfo } = await io.listImportFiles(ctx)
          if (!files.length) {
            return '未找到历史记录文件'
          }
          // 使用序号选择文件导入
          const selector = args[0]
          if (selector) {
            if (selector > 0 && selector <= files.length) {
              const targetFile = files[selector - 1]
              await session.send(`正在${options.force ? '覆盖' : ''}导入文件：\n- ${targetFile}`)
              return await io.importFromFile(ctx, targetFile, options.force)
            }
            return '请输入正确的序号'
          }

          // 显示文件列表
          const fileList = files.map((file, index) => {
            const info = fileInfo[file] || {}
            let prefix = '📄'
            if (file.includes('(N=')) {
              prefix = '📦'
            } else if (info.isBatch) {
              prefix = '📎'
            }
            return `${index + 1}.${prefix}${file}`
          }).join('\n')

          return `使用 import [序号]导入对应文件：\n${fileList}`
        } catch (e) {
          return `导入失败：${e.message}`
        }
      })
  }
}
