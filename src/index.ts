import { Context, Schema } from 'koishi'
import { database } from './database'
import { io } from './io'
import { utils } from './utils'

/**
 * @packageDocumentation
 * 统计与排名插件 - 用于统计和分析用户命令使用情况与活跃度
 */

/**
 * 插件名称及依赖配置
 * @public
 */
export const name = 'statistical-ranking'
export const inject = ['database']

/**
 * 插件配置接口
 * @interface Config
 * @property {boolean} [enableImport] - 是否启用数据导入功能
 * @property {boolean} [enableClear] - 是否启用数据清除功能
 * @property {boolean} [enableDisplayFilter] - 是否启用显示过滤功能
 * @property {string[]} [displayBlacklist] - 显示过滤黑名单
 * @property {string[]} [displayWhitelist] - 显示过滤白名单
 * @property {boolean} [enableExport] - 是否启用导出功能
 */
export interface Config {
  enableImport?: boolean
  enableClear?: boolean
  enableDisplayFilter?: boolean
  displayBlacklist?: string[]
  displayWhitelist?: string[]
  enableExport?: boolean
}

/**
 * 插件配置模式
 * 使用 Schema.intersect 组合多个配置块
 */
export const Config = Schema.intersect([
  Schema.object({
    enableImport: Schema.boolean().default(true).description('启用统计数据导入命令'),
    enableExport: Schema.boolean().default(true).description('启用统计数据导出命令'),
    enableClear: Schema.boolean().default(true).description('启用统计数据清除命令'),
    enableDisplayFilter: Schema.boolean().default(false).description('启用显示过滤功能'),
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
 * @property {string} command - 命令名称，普通消息时为 'mess_age'
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

    const commandValue = command || 'mess_age'
    await database.saveRecord(ctx, { ...info, command: commandValue })
  }

  ctx.on('command/before-execute', ({session, command}) => handleRecord(session, command.name))
  ctx.on('message', (session) => handleRecord(session, null))

  const stat = ctx.command('stat', '查看统计信息')
    .action(async ({ session }) => {
      if (!session?.userId || !session?.platform) return '无法获取您的用户信息'

      // 获取用户完整信息
      const userInfo = await utils.getSessionInfo(session)
      if (!userInfo) return '无法获取您的用户信息'

      // 查询当前用户的统计数据
      const options = { user: userInfo.userId, platform: userInfo.platform }
      const result = await utils.handleStatQuery(ctx, options, 'user')
      if (typeof result === 'string') return result

      const processed = await utils.processStatRecords(result.records, 'command', {
        sortBy: 'count',
        disableCommandMerge: false,
        displayBlacklist: config.enableDisplayFilter ? config.displayBlacklist : [],
        displayWhitelist: config.enableDisplayFilter ? config.displayWhitelist : [],
        title: `${userInfo.userName || userInfo.userId} 的使用统计 ——`
      })

      return processed.title + '\n' + processed.items.join('\n')
    })

  // 将原stat命令的功能移动到stat.command子命令中
  stat.subcommand('.command [arg:string]', '查看命令统计')
    .option('user', '-u [user:string] 指定用户统计')
    .option('guild', '-g [guild:string] 指定群组统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .option('all', '-a 显示所有记录')
    .option('page', '-n [page:number] 指定页码', { fallback: 1 })
    .action(async ({options, args}) => {
      const arg = args[0]?.toLowerCase()
      if (arg === 'all') {
        options.all = true
      } else if (arg && /^\d+$/.test(arg)) {
        options.page = parseInt(arg)
      }
      const result = await utils.handleStatQuery(ctx, options, 'command')
      if (typeof result === 'string') return result
      const pageSize = 15
      const processed = await utils.processStatRecords(result.records, 'command', {
        sortBy: 'key',
        disableCommandMerge: options.all,
        displayBlacklist: options.all ? [] : (config.enableDisplayFilter ? config.displayBlacklist : []),
        displayWhitelist: options.all ? [] : (config.enableDisplayFilter ? config.displayWhitelist : []),
        page: options.page || 1,
        pageSize,
        title: result.title,
        skipPaging: options.all
      })

      return processed.title + '\n' + processed.items.join('\n')
    })

  stat.subcommand('.user [arg:string]', '查看发言统计')
    .option('guild', '-g [guild:string] 指定群组统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .option('all', '-a 显示所有记录')
    .option('page', '-n [page:number] 指定页码', { fallback: 1 })
    .action(async ({options, args}) => {
      const arg = args[0]?.toLowerCase()
      if (arg === 'all') {
        options.all = true
      } else if (arg && /^\d+$/.test(arg)) {
        options.page = parseInt(arg)
      }
      const result = await utils.handleStatQuery(ctx, options, 'user')
      if (typeof result === 'string') return result
      const pageSize = 15
      const processed = await utils.processStatRecords(result.records, 'userId', {
        truncateId: true,
        displayBlacklist: options.all ? [] : (config.enableDisplayFilter ? config.displayBlacklist : []),
        displayWhitelist: options.all ? [] : (config.enableDisplayFilter ? config.displayWhitelist : []),
        page: options.page || 1,
        pageSize,
        title: result.title,
        skipPaging: options.all
      })

      return processed.title + '\n' + processed.items.join('\n')
    })

  stat.subcommand('.guild [arg:string]', '查看群组统计')
    .option('user', '-u [user:string] 指定用户统计')
    .option('platform', '-p [platform:string] 指定平台统计')
    .option('command', '-c [command:string] 指定命令统计')
    .option('all', '-a 显示所有记录')
    .option('page', '-n [page:number] 指定页码', { fallback: 1 })
    .action(async ({options, args}) => {
      const arg = args[0]?.toLowerCase()
      if (arg === 'all') {
        options.all = true
      } else if (arg && /^\d+$/.test(arg)) {
        options.page = parseInt(arg)
      }
      const result = await utils.handleStatQuery(ctx, options, 'guild')
      if (typeof result === 'string') return result
      const pageSize = 15
      const processed = await utils.processStatRecords(result.records, 'guildId', {
        truncateId: true,
        displayBlacklist: options.all ? [] : (config.enableDisplayFilter ? config.displayBlacklist : []),
        displayWhitelist: options.all ? [] : (config.enableDisplayFilter ? config.displayWhitelist : []),
        page: options.page || 1,
        pageSize,
        title: result.title,
        skipPaging: options.all
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
        const itemMap = new Map<string, string>()
        records.forEach(record => {
          const id = record[key] as string
          if (!id) return
          if (key === 'userId' && record.userName) {
            itemMap.set(id, `${record.userName} (${id})`)
          } else if (key === 'guildId' && record.guildName) {
            itemMap.set(id, `${record.guildName} (${id})`)
          } else {
            itemMap.set(id, id)
          }
        })
        const items = Array.from(itemMap.values())
        return items.length ? `${title} ——\n${items.join(',')}` : null
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
          : '已删除所有统计记录'
      })
  }

  if (config.enableExport) {
    stat.subcommand('.export', '导出统计数据', { authority: 4 })
      .option('csv', '-C 使用CSV格式导出')
      .option('user', '-u [user:string] 指定用户')
      .option('platform', '-p [platform:string] 指定平台')
      .option('guild', '-g [guild:string] 指定群组')
      .option('cmd', '-c [command:string] 指定命令')
      .option('batch', '-b [size:number] 设置每批数据量', { fallback: 200 })
      .action(async ({ options, session }) => {
        try {
          const result = await io.exportToFile(ctx, 'stat-export', {
            userId: options.user,
            platform: options.platform,
            guildId: options.guild,
            command: options.cmd,
            batchSize: options.batch
          })

          if (result.batches === 1) {
            return `成功导出 ${result.count} 条记录到 ${result.files[0].filename}`
          } else {
            await session.send(`数据量较大，已分 ${result.batches} 批导出 ${result.count} 条记录:`)
            const fileList = result.files.map(f => `- ${f.filename} (${f.count}条记录)`).join('\n')
            return fileList
          }
        } catch (e) {
          return `导出失败：${e.message}`
        }
      })
  }

  if (config.enableImport) {
    stat.subcommand('.import [selector:string]', '导入统计数据', { authority: 4 })
      .option('force', '-f 覆盖现有数据')
      .option('database', '-d 从历史数据库导入')
      .action(async ({ session, options, args }) => {
        try {
          // 从历史数据库导入
          if (options.database) {
            session.send('开始从历史数据导入，这可能需要一段时间，请稍候...')
            try {
              const result = await io.importLegacyData(ctx, options.force)
              return `${result}`
            } catch (e) {
              if (e.message.includes('找不到历史数据表')) {
                return '历史数据表不存在，无法从数据库导入'
              }
              throw e
            }
          }

          // 获取可导入文件列表
          const { files, fileInfo } = await io.listImportFiles(ctx)
          if (!files.length) {
            return '没有找到可导入的文件。请确保在data/stat目录下有JSON格式的统计数据文件。'
          }

          // 如果有参数但不是数字，视为文件名直接导入
          const selector = args[0]
          if (selector && isNaN(parseInt(selector))) {
            // 检查文件是否存在
            if (!files.some(f => f === selector)) {
              // 尝试模糊匹配，找到包含输入名称的文件
              const matchFiles = files.filter(f => f.includes(selector))
              if (matchFiles.length > 0) {
                return `未找到精确匹配的文件: ${selector}\n您是否要导入以下文件之一?\n${matchFiles.map((f, i) => `${i+1}. ${f}`).join('\n')}`
              }
              return `未找到文件: ${selector}\n可用文件列表:\n${files.map((f, i) => `${i+1}. ${f}`).join('\n')}`
            }

            // 如果选择的是批次组文件，确认是否导入所有批次
            if (selector.includes('批次组')) {
              await session.send(`您选择的是批次组文件 ${selector}，将导入该组中的所有批次文件。`)
            }

            session.send(`开始导入文件 ${selector}${options.force ? ' (覆盖模式)' : ''}，这可能需要一段时间，请稍候...`)
            const result = await io.importFromFile(ctx, selector, options.force)
            return result
          }

          // 如果提供了有效序号，导入对应文件
          if (selector) {
            const index = parseInt(selector) - 1
            if (index >= 0 && index < files.length) {
              const selectedFile = files[index]

              // 如果选择的是批次组文件，确认是否导入所有批次
              if (selectedFile.includes('批次组')) {
                await session.send(`您选择的是批次组文件 ${selectedFile}，将导入该组中的所有批次文件。`)
              }

              session.send(`开始导入文件 ${selectedFile}${options.force ? ' (覆盖模式)' : ''}，这可能需要一段时间，请稍候...`)
              const result = await io.importFromFile(ctx, selectedFile, options.force)
              return result
            } else {
              return `无效的文件序号，请输入1-${files.length}之间的数字`
            }
          }

          // 显示文件列表，突出显示批次组
          const fileList = files.map((file, index) => {
            const info = fileInfo[file]
            const prefix = file.includes('批次组') ? '📦 ' : '📄 '
            const size = info?.size || 'unknown'
            const time = info?.mtime || 'unknown'
            return `${index + 1}. ${prefix}${file} (${size}, ${time})`
          }).join('\n')

          return `请选择要导入的文件序号:\n${fileList}\n\n使用命令: stat.import <序号|文件名> [-f] 进行导入\n使用-f参数可覆盖现有数据\n📦 表示批次组文件，选择后将导入该组所有批次文件`
        } catch (e) {
          ctx.logger.error(`导入失败: ${e.message}`, e.stack)
          return `导入失败：${e.message}`
        }
      })
  }
}
