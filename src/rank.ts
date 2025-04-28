import { Context, h } from 'koishi'
import {} from 'koishi-plugin-cron'
import { Utils } from './utils'
import { Renderer } from './render'

/**
 * 用户排名差异数据接口
 * @interface RankDiff
 * @property {string} userId - 用户ID
 * @property {string} userName - 用户名称
 * @property {number} currentCount - 当前计数
 * @property {number} previousCount - 上一时段计数
 * @property {number} diff - 差值（当前减去上一时段）
 * @property {number} rank - 当前排名
 * @property {number} [prevRank] - 上一时段排名
 * @property {number} [rankChange] - 排名变化（正值表示上升，负值表示下降）
 */
interface RankDiff {
  userId: string,
  userName: string,
  currentCount: number,
  previousCount: number,
  diff: number,
  rank: number,
  prevRank?: number,
  rankChange?: number
}

/**
 * 排行榜配置接口
 * @interface RankConfig
 * @property {string} [updateInterval] - 更新间隔
 * @property {boolean} [defaultImageMode] - 默认是否使用图片模式
 */
interface RankConfig {
  updateInterval?: string
  defaultImageMode?: boolean
}

export class Rank {
  private ctx: Context
  private defaultImageMode: boolean

  /**
   * 创建排行榜实例
   * @param {Context} ctx - Koishi 上下文
   * @param {RankConfig} [config={}] - 排行榜配置
   */
  constructor(ctx: Context, config: RankConfig = {}) {
    this.ctx = ctx
    this.defaultImageMode = !!config.defaultImageMode
  }

  /**
   * 生成排行榜快照
   * 保存当前消息统计数据到排行数据库中
   * @returns {Promise<void>}
   */
  async generateRankSnapshot() {
    const currentTimestamp = new Date();
    currentTimestamp.setMinutes(0, 0, 0);
    try {
      const records = await this.ctx.database.get('analytics.stat', { command: '_message' })
      if (!records.length) return
      const statIds = records.filter(r => r.id).map(r => r.id)
      const prevSnapshots = await this.ctx.database.get('analytics.rank', {
        stat: { $in: statIds }, timestamp: { $lt: currentTimestamp }
      }, { sort: { timestamp: 'desc' } })
      const prevMap = new Map()
      prevSnapshots.forEach(snap => {
        if (!prevMap.has(snap.stat) || prevMap.get(snap.stat).timestamp < snap.timestamp)
          prevMap.set(snap.stat, snap)
      })
      const existSet = new Set((await this.ctx.database.get('analytics.rank',
        { timestamp: currentTimestamp }, ['stat'])).map(r => r.stat))
      const snapshots = records
        .filter(r => r.id &&
          (!prevMap.has(r.id) || prevMap.get(r.id).count !== r.count) &&
          !existSet.has(r.id))
        .map(r => ({ stat: r.id, timestamp: currentTimestamp, count: r.count }))
      if (snapshots.length) {
        await this.ctx.database.upsert('analytics.rank', snapshots)
        this.ctx.logger.info(`已更新 ${snapshots.length} 条排行记录`)
      }
    } catch (error) {
      this.ctx.logger.error('排行更新失败:', error)
    }
  }

  /**
   * 获取排行榜数据
   * @param {string} platform - 平台标识
   * @param {string|null} guildId - 群组ID，为null时表示全局排行
   * @param {number} [hours=24] - 时间范围（小时）
   * @param {number} [limit=10] - 返回结果数量限制，负数表示不限制
   * @param {boolean} [global=false] - 是否获取全局排行
   * @param {Date} [endTime] - 结束时间，默认为当前时间
   * @returns {Promise<RankDiff[]>} 排行榜数据数组
   */
  async getRankingData(platform: string, guildId: string | null, hours = 24, limit = 10, global = false, endTime?: Date): Promise<RankDiff[]> {
    try {
      // 获取统计数据
      const statQuery = { platform, command: '_message', ...((!global && guildId) ? { guildId } : {}) }
      const statRecords = await this.ctx.database.get('analytics.stat', statQuery)
      if (!statRecords.length) return []
      const statIds = statRecords.filter(r => r.id).map(r => r.id)
      if (!statIds.length) return []
      // 计算时间点
      const currentTimestamp = endTime || new Date()
      if (!endTime) currentTimestamp.setMinutes(0, 0, 0)
      const previousTimestamp = new Date(currentTimestamp)
      previousTimestamp.setHours(previousTimestamp.getHours() - hours)
      const olderTimestamp = new Date(previousTimestamp)
      olderTimestamp.setHours(previousTimestamp.getHours() - hours)
      // 创建数据映射并获取历史数据
      const userMap = new Map(statRecords
        .filter(r => r.id)
        .map(r => [r.id, { userId: r.userId, userName: Utils.sanitizeString(r.userName || r.userId) }]))
      // 获取前一时段和更早时段数据
      const getSnapMap = data => {
        const map = new Map()
        data.forEach(r => {
          if (!map.has(r.stat) || map.get(r.stat).timestamp < r.timestamp)
            map.set(r.stat, r)
        })
        return map
      }
      const [previousRankData, olderRankData] = await Promise.all([
        this.ctx.database.get('analytics.rank', {
          stat: { $in: statIds }, timestamp: { $lte: previousTimestamp }
        }, { sort: { timestamp: 'desc' } }),
        this.ctx.database.get('analytics.rank', {
          stat: { $in: statIds }, timestamp: { $lte: olderTimestamp }
        }, { sort: { timestamp: 'desc' } })
      ])
      const prevRankMap = getSnapMap(previousRankData)
      const olderRankMap = getSnapMap(olderRankData)
      // 计算排名数据
      const currentIntervals = statRecords
        .filter(r => r.id)
        .map(record => {
          const prev = prevRankMap.get(record.id)
          const prevCount = prev?.count ?? 0
          const diff = record.count - prevCount
          return {
            stat: record.id,
            userId: record.userId,
            userName: userMap.get(record.id)?.userName || record.userId,
            intervalCount: diff,
            currentCount: record.count,
            previousCount: prevCount,
            rank: 0,
            prevRank: undefined,
            rankChange: null
          }
        })
        .filter(item => item.intervalCount > 0)
      // 排序并分配排名
      currentIntervals.sort((a, b) => b.intervalCount - a.intervalCount)
      let currentRank = 1, prevCount = -1
      currentIntervals.forEach((item, idx) => {
        if (idx > 0 && item.intervalCount === prevCount) {
          // 保持并列排名
        } else {
          currentRank = idx + 1
        }
        item.rank = currentRank
        prevCount = item.intervalCount
      })
      // 计算上一时间段排名
      const sortedPrevRanks = [...prevRankMap.entries()]
        .map(([statId, prev]) => ({
          stat: statId,
          intervalCount: prev.count - (olderRankMap.get(statId)?.count ?? 0)
        }))
        .filter(item => item.intervalCount > 0)
        .sort((a, b) => b.intervalCount - a.intervalCount)
      const prevRanks = new Map()
      let prevRank = 1, prevIntervalCount = -1
      sortedPrevRanks.forEach((item, idx) => {
        if (idx > 0 && item.intervalCount === prevIntervalCount) {
          // 保持并列排名
        } else {
          prevRank = idx + 1
        }
        prevRanks.set(item.stat, prevRank)
        prevIntervalCount = item.intervalCount
      })
      // 更新排名变化
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
   * 注册排行榜相关命令
   * @param {any} stat - 统计命令对象
   */
  registerRankCommands(stat) {
    stat.subcommand('.rank [arg:string]', '查看发言排行')
      .option('guild', '-g [guild:string] 指定群组排行', { authority: 2 })
      .option('platform', '-p [platform:string] 指定平台排行', { authority: 2 })
      .option('time', '-t [timerange:string] 指定时间范围')
      .option('endTime', '-e [endtime:string] 指定结束时间')
      .option('visual', '-v 切换可视化模式')
      .option('all', '-a 显示全局排行')
      .action(async ({ session, options, args }) => {
        try {
          const arg = args[0]?.toLowerCase()
          const showAll = arg === 'all'
          const page = arg && /^\d+$/.test(arg) ? parseInt(arg) : 1
          const platform = options.platform || session.platform
          const guildId = options.all ? null : (options.guild || session.guildId)
          if (!options.all && !guildId) return '暂无数据'
          // 解析时间
          const { hours, description: timeDesc } = this.parseTimeFormat(options.time || 'd')
          let endTime = null, timeDescription = timeDesc
          if (options.endTime) {
            const { hours: endHours, description: endDesc } = this.parseTimeFormat(options.endTime)
            endTime = new Date()
            endTime.setMinutes(0, 0, 0)
            endTime.setHours(endTime.getHours() - endHours)
            timeDescription = `近${endDesc.replace(/^近/, '')}到近${timeDesc.replace(/^近/, '')}`
          }
          // 获取群组名称并构建标题
          const guildName = guildId ? await session.bot.getGuild?.(guildId)
            .then(guild => guild?.name || guildId)
            .catch(() => guildId) : ''
          const conditions = Utils.buildConditions({
            guild: options.all ? null : (guildName || null),
            platform: options.platform ? platform : null,
          })
          const title = conditions.length
            ? `${conditions.join('、')}${timeDescription}的发言排行`
            : `全局${timeDescription}的发言排行`
          // 获取排行数据
          const allRankData = await this.getRankingData(platform, guildId, hours, -1, !!options.all, endTime)
          if (!allRankData.length) return `${guildName || platform} 暂无数据`
          // 处理分页
          const pageSize = 15
          const totalPages = Math.ceil(allRankData.length / pageSize) || 1
          const pagedData = showAll ? allRankData : allRankData.slice(
            (Math.min(Math.max(1, page), totalPages) - 1) * pageSize,
            Math.min(Math.max(1, page), totalPages) * pageSize
          )
          const finalTitle = (showAll || totalPages <= 1) ? title : `${title}（第${page}/${totalPages}页）`
          // 确定渲染模式并返回结果
          const useImageMode = options.visual !== undefined ? !this.defaultImageMode : this.defaultImageMode
          return (useImageMode && this.ctx.puppeteer)
            ? this.renderImageRanking(allRankData, title)
            : this.formatRankingText(pagedData, finalTitle)
        } catch (error) {
          this.ctx.logger.error('排行处理出错:', error)
          return '排行获取出错'
        }
      })
  }

  /**
   * 渲染图片形式的排行榜
   * @private
   * @param {RankDiff[]} data - 排行榜数据
   * @param {string} title - 排行榜标题
   * @returns {Promise<any>} 渲染后的图片或图片数组
   */
  private async renderImageRanking(data: RankDiff[], title: string) {
    const renderer = new Renderer(this.ctx)
    const imagePages = Utils.paginateArray(data)
    return Promise.all(imagePages.map((page, i) =>
      renderer.renderRankingImage(
        page,
        imagePages.length > 1 ? `${title}（第${i+1}/${imagePages.length}页）` : title
      )
    )).then(results =>
      results.length === 1 ? h.image(results[0], 'image/png')
        : results.map(buffer => h.image(buffer, 'image/png')).join('\n')
    )
  }

  /**
   * 解析时间格式字符串
   * @private
   * @param {string} format - 时间格式字符串，如 "1d", "2w" 等
   * @returns {{ hours: number, description: string }} 解析后的小时数和描述文本
   */
  private parseTimeFormat(format: string): { hours: number, description: string } {
    const units = {
      h: { hours: 1, name: '小时' },
      d: { hours: 24, name: '天' },
      w: { hours: 168, name: '周' },
      m: { hours: 720, name: '月' },
      y: { hours: 8760, name: '年' }
    }
    if (units[format]) return { hours: units[format].hours, description: `近1${units[format].name}` }
    const match = /^(\d+)([hdwmy])$/.exec(format)
    if (match) {
      const value = parseInt(match[1], 10)
      const unitInfo = units[match[2]] || { hours: 24, name: '天' }
      return { hours: Math.max(1, Math.ceil(value * unitInfo.hours)), description: `近${value}${unitInfo.name}` }
    }
    return { hours: 24, description: '近1天' }
  }

  /**
   * 格式化排行榜文本
   * @private
   * @param {RankDiff[]} data - 排行榜数据
   * @param {string} title - 排行榜标题
   * @returns {string} 格式化后的排行榜文本
   */
  formatRankingText(data: RankDiff[], title: string): string {
    if (!data.length) return `${title}\n暂无数据`
    const lines = data.map(item => {
      const rankChangeText = item.rankChange === null ? '新' :
        item.rankChange > 0 ? `↑${item.rankChange}` :
        item.rankChange < 0 ? `↓${Math.abs(item.rankChange)}` : '-'
      const nameWidth = 20
      const name = Utils.truncateByDisplayWidth(item.userName, nameWidth)
      const nameLen = name ? Array.from(name).reduce((w, c) =>
        w + (/[\u3000-\u9fff\uff01-\uff60\u2E80-\u2FDF\u3040-\u30FF\u2600-\u26FF\u2700-\u27BF]/.test(c) ? 2 : 1), 0) : 0
      return `${item.rank.toString().padStart(2)}. ${name}${' '.repeat(Math.max(0, nameWidth - nameLen))} +${item.diff}条 ${rankChangeText}`
    }).join('\n')
    return `${title} ——\n${lines}`
  }
}