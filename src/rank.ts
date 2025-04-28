import { Context, h } from 'koishi'
import {} from 'koishi-plugin-cron'
import { Utils } from './utils'
import { Renderer } from './render'

/**
 * 表示排名差异数据的接口
 * @interface RankDiff
 * @property {string} userId - 用户ID
 * @property {string} userName - 用户名称
 * @property {number} currentCount - 当前计数
 * @property {number} previousCount - 之前计数
 * @property {number} diff - 差值
 * @property {number} rank - 当前排名
 * @property {number} [prevRank] - 之前排名（可选）
 * @property {number} [rankChange] - 排名变化（可选）
 */
interface RankDiff {
  userId: string, userName: string, currentCount: number, previousCount: number,
  diff: number, rank: number, prevRank?: number, rankChange?: number
}

/**
 * 排名功能配置接口
 * @interface RankConfig
 * @property {string} [updateInterval] - 更新间隔
 * @property {boolean} [defaultImageMode] - 默认是否使用图像模式
 */
interface RankConfig {
  updateInterval?: string
  defaultImageMode?: boolean
}

/**
 * 排名功能实现类
 * @class Rank
 */
export class Rank {
  /** Koishi 上下文 */
  private ctx: Context
  /** 默认是否使用图像模式 */
  private defaultImageMode: boolean

  /**
   * 创建排名类实例
   * @param {Context} ctx - Koishi 上下文
   * @param {RankConfig} config - 排名配置
   */
  constructor(ctx: Context, config: RankConfig = {}) {
    this.ctx = ctx
    this.defaultImageMode = !!config.defaultImageMode
  }

  /**
   * 生成排名快照，记录当前数据状态
   * @returns {Promise<void>}
   */
  async generateRankSnapshot() {
    const currentTimestamp = new Date(new Date()); currentTimestamp.setMinutes(0, 0, 0);
    try {
      // 获取记录和之前的快照
      const records = await this.ctx.database.get('analytics.stat', { command: '_message' })
      if (!records.length) return
      const statIds = records.filter(r => r.id).map(r => r.id)
      const prevSnapshots = await this.ctx.database.get('analytics.rank', {
        stat: { $in: statIds }, timestamp: { $lt: currentTimestamp }
      }, { sort: { timestamp: 'desc' } })
      // 找出需要更新的记录
      const prevMap = new Map()
      prevSnapshots.forEach(snap => {
        if (!prevMap.has(snap.stat) || prevMap.get(snap.stat).timestamp < snap.timestamp)
          prevMap.set(snap.stat, snap)
      })
      // 筛选并准备更新
      const existing = await this.ctx.database.get('analytics.rank',
        { timestamp: currentTimestamp }, ['stat'])
      const existSet = new Set(existing.map(r => r.stat))
      const snapshots = records
        .filter(r => r.id && (!prevMap.has(r.id) || prevMap.get(r.id).count !== r.count))
        .filter(r => r.id && !existSet.has(r.id))
        .map(r => ({ stat: r.id, timestamp: currentTimestamp, count: r.count }))
      if (snapshots.length) {
        await this.ctx.database.upsert('analytics.rank', snapshots)
        this.ctx.logger.info(`已更新 ${snapshots.length} 条排行记录`)
      } else {
        this.ctx.logger.info('无需更新排行记录')
      }
    } catch (error) { this.ctx.logger.error('排行更新失败:', error) }
  }

  /**
   * 获取排名数据
   * @param {string} platform - 平台标识
   * @param {string | null} guildId - 群组ID，为 null 时表示全局
   * @param {number} hours - 时间范围（小时）
   * @param {number} limit - 限制返回数量，-1 表示不限制
   * @param {boolean} global - 是否获取全局数据
   * @returns {Promise<RankDiff[]>} 排名差异数据数组
   */
  async getRankingData(platform: string, guildId: string | null, hours = 24, limit = 10, global = false): Promise<RankDiff[]> {
    try {
      // 获取数据
      const statQuery = { platform, command: '_message' }
      if (!global && guildId) statQuery['guildId'] = guildId
      const statRecords = await this.ctx.database.get('analytics.stat', statQuery)
      if (!statRecords.length) return []
      const statIds = statRecords.filter(r => r.id).map(r => r.id)
      if (!statIds.length) return []
      // 计算时间点
      const currentTimestamp = new Date(new Date()); currentTimestamp.setMinutes(0, 0, 0);
      const previousTimestamp = new Date(currentTimestamp)
      previousTimestamp.setHours(previousTimestamp.getHours() - hours)
      const olderTimestamp = new Date(previousTimestamp)
      olderTimestamp.setHours(previousTimestamp.getHours() - hours)
      // 获取历史数据
      const [previousRankData, olderRankData] = await Promise.all([
        this.ctx.database.get('analytics.rank', {
          stat: { $in: statIds }, timestamp: { $lte: previousTimestamp }
        }, { sort: { timestamp: 'desc' } }),
        this.ctx.database.get('analytics.rank', {
          stat: { $in: statIds }, timestamp: { $lte: olderTimestamp }
        }, { sort: { timestamp: 'desc' } })
      ])
      // 准备映射
      const userMap = new Map(statRecords
        .filter(r => r.id)
        .map(r => [r.id, { userId: r.userId, userName: Utils.sanitizeString(r.userName || r.userId) }]))
      const getSnapMap = data => {
        const map = new Map();
        data.forEach(r => {
          if (!map.has(r.stat) || map.get(r.stat).timestamp < r.timestamp)
            map.set(r.stat, r)
        });
        return map
      }
      const prevRankMap = getSnapMap(previousRankData)
      const olderRankMap = getSnapMap(olderRankData)
      // 计算当前时间段增量
      const currentIntervals = statRecords
        .filter(r => r.id)
        .map(record => {
          const prev = prevRankMap.get(record.id)
          const prevCount = prev?.count ?? 0
          const diff = record.count - prevCount
          return {
            stat: record.id, userId: record.userId,
            userName: userMap.get(record.id)?.userName || record.userId,
            intervalCount: diff, currentCount: record.count, previousCount: prevCount,
            rank: 0, prevRank: undefined, rankChange: null
          }
        })
        .filter(item => item.intervalCount > 0)
      // 计算上一时间段增量
      const prevIntervals = [...prevRankMap.entries()]
        .map(([statId, prev]) => ({
          stat: statId,
          intervalCount: prev.count - (olderRankMap.get(statId)?.count ?? 0)
        }))
        .filter(item => item.intervalCount > 0)
      // 计算排名和变化
      currentIntervals.sort((a, b) => b.intervalCount - a.intervalCount)
      currentIntervals.forEach((item, idx) => { item.rank = idx + 1 })
      prevIntervals.sort((a, b) => b.intervalCount - a.intervalCount)
      const prevRanks = new Map(prevIntervals.map((item, idx) => [item.stat, idx + 1]))
      currentIntervals.forEach(item => {
        item.prevRank = prevRanks.get(item.stat)
        item.rankChange = item.prevRank ? item.prevRank - item.rank : null
      })
      // 返回结果
      return currentIntervals
        .slice(0, limit >= 0 ? limit : currentIntervals.length)
        .map(({ userId, userName, currentCount, previousCount, intervalCount, rank, prevRank, rankChange }) =>
          ({ userId, userName, currentCount, previousCount, diff: intervalCount, rank, prevRank, rankChange }))
    } catch (error) {
      this.ctx.logger.error('排行获取出错:', error)
      return []
    }
  }

  /**
   * 注册排名相关指令
   * @param {any} stat - 统计命令实例
   */
  registerRankCommands(stat) {
    stat.subcommand('.rank [arg:string]', '查看发言排行')
      .option('guild', '-g [guild:string] 指定群组排行', { authority: 2 })
      .option('platform', '-p [platform:string] 指定平台排行', { authority: 2 })
      .option('time', '-t [timerange:string] 指定时间范围', { fallback: 'd' })
      .option('visual', '-v 切换可视化模式')
      .option('all', '-a 显示全局排行')
      .action(async ({ session, options, args }) => {
        const arg = args[0]?.toLowerCase()
        const showAll = arg === 'all'
        let page = arg && /^\d+$/.test(arg) ? parseInt(arg) : 1, pageSize = 15
        const { hours, description } = this.parseTimeRange(options.time || 'd')
        const platform = options.platform || session.platform
        const guildId = options.all ? null : (options.guild || session.guildId)
        if (!options.all && !guildId) return '暂无数据'
        try {
          // 获取群组名称和构建标题
          const guildName = guildId ? await session.bot.getGuild?.(guildId)
            .then(guild => guild?.name || guildId).catch(() => guildId) : ''
          const showPlatform = !!options.platform
          const conditions = Utils.buildConditions({
            guild: guildId ? guildName || guildId : null,
            platform: showPlatform ? platform : null,
          })
          const title = conditions.length
            ? `${conditions.join('、')}${description}的发言排行`
            : `全局${description}的发言排行`
          // 获取排行数据
          const allRankData = await this.getRankingData(platform, guildId, hours, -1, !!options.all)
          if (!allRankData.length) return `${guildName || platform} 暂无数据`
          // 分页处理
          let pagedRankData, totalPages = 1
          if (showAll) {
            pagedRankData = allRankData
          } else {
            totalPages = Math.ceil(allRankData.length / pageSize) || 1
            page = Math.min(Math.max(1, page), totalPages)
            pagedRankData = allRankData.slice((page - 1) * pageSize, page * pageSize)
          }
          const finalTitle = `${title}${(showAll || totalPages <= 1) ? '' : `（第${page}/${totalPages}页）`}`
          // 渲染模式
          const useImageMode = options.visual !== undefined ? !this.defaultImageMode : this.defaultImageMode
          if (useImageMode && this.ctx.puppeteer) {
            const renderer = new Renderer(this.ctx)
            const imagePages = Utils.paginateArray(allRankData)
            const buffers = []
            for (let i = 0; i < imagePages.length; i++) {
              buffers.push(await renderer.renderRankingImage(
                imagePages[i],
                imagePages.length > 1 ? `${title}（第${i+1}/${imagePages.length}页）` : title
              ))
            }
            return buffers.length === 1
              ? h.image(buffers[0], 'image/png')
              : buffers.map(buffer => h.image(buffer, 'image/png')).join('\n')
          }
          return this.formatRankingText(pagedRankData, finalTitle)
        } catch (error) {
          this.ctx.logger.error('排行获取出错:', error)
          return '排行获取出错'
        }
      })
  }

  /**
   * 解析时间范围字符串
   * @param {string} timerange - 时间范围字符串，如 'd'（天）、'w'（周）
   * @returns {{ hours: number, description: string }} 包含小时数和描述的对象
   * @private
   */
  private parseTimeRange(timerange: string): { hours: number, description: string } {
    const hourMap = { h: 1, d: 24, w: 168, m: 720, y: 8760 }
    const descMap = { h: '近1时', d: '昨日', w: '近7天', m: '近30天', y: '近1年' }
    if (hourMap[timerange]) return { hours: hourMap[timerange], description: descMap[timerange] }
    const match = /^(\d+)([hdwmy])$/.exec(timerange)
    if (match) {
      const value = parseInt(match[1], 10), unit = match[2]
      const hours = Math.max(1, Math.ceil(value * (hourMap[unit] || 24)))
      const unitNames = { h: '时', d: '天', w: '周', m: '月', y: '年' }
      return { hours, description: `近${value}${unitNames[unit] || '天'}` }
    }
    return { hours: 24, description: '昨日' }
  }

  /**
   * 格式化排名数据为文本输出
   * @param {RankDiff[]} data - 排名数据
   * @param {string} title - 标题
   * @returns {string} 格式化的排名文本
   */
  formatRankingText(data: RankDiff[], title: string): string {
    if (!data.length) return `${title}\n暂无数据`
    const lines = data.map(item => {
      const rankChangeText =
        item.rankChange === null ? '新' :
        item.rankChange > 0 ? `↑${item.rankChange}` :
        item.rankChange < 0 ? `↓${Math.abs(item.rankChange)}` : '-'
      const nameWidth = 20
      const name = Utils.truncateByDisplayWidth(item.userName, nameWidth)
      const padding = ' '.repeat(Math.max(0, nameWidth - (name ? Array.from(name).reduce((w, c) => w + (/[\u3000-\u9fff\uff01-\uff60\u2E80-\u2FDF\u3040-\u30FF\u2600-\u26FF\u2700-\u27BF]/.test(c) ? 2 : 1), 0) : 0)))
      return `${item.rank.toString().padStart(2)}. ${name}${padding} +${item.diff}条 ${rankChangeText}`
    }).join('\n')
    return `${title} ——\n${lines}`
  }
}