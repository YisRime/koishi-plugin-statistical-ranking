import { Context } from 'koishi'
import {} from 'koishi-plugin-puppeteer'
import { StatProcessOptions } from './stat'
import { StatRecord } from './index'
import { Utils } from './utils'

/**
 * 统计数据渲染类
 * 负责将统计数据渲染为可视化图表
 *
 * 图片样式说明:
 * - 整体风格：现代简约风格，白色背景配合柔和阴影和圆角设计
 * - 颜色方案：
 *   · 命令统计：靛蓝色(#6366f1)表头
 *   · 用户统计：珊瑚色(#f56565)表头
 *   · 群组统计：绿松石色(#4fd1c5)表头
 * - 布局结构：
 *   · 顶部标题栏：包含总项目数、主标题和时间戳
 *   · 数据表格：四列布局(名称、数量、占比、最后统计时间)
 *   · 综合统计图：多个数据表垂直排列
 */
export class Renderer {
  private ctx: Context

  /**
   * 创建渲染器实例
   * @param {Context} ctx - Koishi上下文
   */
  constructor(ctx: Context) {
    this.ctx = ctx
  }

  /**
   * 将HTML内容转换为图片
   * @param {string} html - 要渲染的HTML内容
   * @param {Object} options - 渲染选项
   * @param {number} [options.width] - 图片宽度
   * @returns {Promise<Buffer>} 图片Buffer数据
   */
  async htmlToImage(html: string, options: { width?: number } = {}): Promise<Buffer> {
    let page: any = null
    try {
      page = await this.ctx.puppeteer.page()
      const initialViewportWidth = options.width || 720
      await page.setViewport({
        width: initialViewportWidth,
        height: 1080,
        deviceScaleFactor: 2.0
      })
      // 设置超时
      await page.setDefaultNavigationTimeout(30000)
      await page.setDefaultTimeout(30000)
      // 设置HTML内容
      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              body {
                margin: 0;
                padding: 0;
                font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
                background: white;
                color: #333;
              }
              table {
                width: 100%;
                table-layout: auto;
                border-collapse: separate;
                border-spacing: 0;
                overflow: hidden;
              }
              th, td {
                transition: background-color 0.2s;
              }
              tr:hover td {
                background-color: #f5f8ff;
              }
              h2, h3 {
                margin: 0;
                letter-spacing: 0.5px;
              }
            </style>
          </head>
          <body>${html}</body>
        </html>
      `, { waitUntil: 'networkidle0' })
      // 计算实际内容宽度和高度
      const dimensions = await page.evaluate(() => {
        const contentWidth = Math.max(
          document.body.scrollWidth,
          document.body.offsetWidth,
          document.documentElement.clientWidth,
          document.documentElement.scrollWidth,
          document.documentElement.offsetWidth
        );
        const contentHeight = document.body.scrollHeight;
        return { width: contentWidth, height: contentHeight };
      });
      // 调整视口大小以完全适应内容
      await page.setViewport({
        width: dimensions.width,
        height: dimensions.height,
        deviceScaleFactor: 2.0
      });
      // 等待所有图片加载完成
      await page.evaluate(() => {
        const imgPromises = Array.from(document.querySelectorAll('img'))
          .map(img => img.complete ? Promise.resolve() :
               new Promise(resolve => {
                 img.addEventListener('load', resolve);
                 img.addEventListener('error', resolve);
               })
          );
        return Promise.all(imgPromises);
      });
      // 截取整个页面
      const imageBuffer = await page.screenshot({
        type: 'png',
        fullPage: true,
        omitBackground: true
      });

      return imageBuffer;
    } catch (error) {
      this.ctx.logger.error('图片渲染出错:', error)
      throw new Error(`图片渲染出错: ${error.message || '未知错误'}`)
    } finally {
      if (page) {
        try {
          await page.close().catch(() => {})
        } catch (e) {
          this.ctx.logger.warn('关闭页面失败:', e)
        }
      }
    }
  }

  /**
   * 将统计记录转换为图表数据
   * @param {StatRecord[]} records - 统计记录数组
   * @param {keyof StatRecord} key - 统计键名
   * @param {StatProcessOptions} options - 处理选项
   * @returns {Array<{name: string, value: number, time: string, rawTime: Date}>} 转换后的图表数据
   */
  recordsToChartData(records: StatRecord[], key: keyof StatRecord, options: StatProcessOptions = {}): Array<{name: string, value: number, time: string, rawTime: Date}> {
    const {
      sortBy = 'count',
      disableCommandMerge = false,
      truncateId = false,
      displayBlacklist = [],
      displayWhitelist = []
    } = options;

    const filteredRecords = Utils.filterStatRecords(records, {
      keyField: key as string,
      displayWhitelist,
      displayBlacklist,
      disableCommandMerge
    });

    const keyFormatter = (key === 'command' && !disableCommandMerge)
      ? (k: string) => k?.split('.')[0] || '' : undefined;

    const dataMap = Utils.generateStatsMap(filteredRecords, key as string, keyFormatter);
    // 转换为图表数据格式
    let chartData = Array.from(dataMap.entries()).map(([key, data]) => {
      let displayName = Utils.formatDisplayName(
        data.displayName,
        key,
        truncateId
      );

      return {
        name: displayName,
        value: data.count,
        time: Utils.formatTimeAgo(data.lastTime),
        rawTime: data.lastTime
      };
    });
    // 排序
    chartData.sort((a, b) => {
      if (sortBy === 'count') return b.value - a.value;
      if (sortBy === 'time') return b.rawTime.getTime() - a.rawTime.getTime();
      return a.name.localeCompare(b.name);
    });

    return chartData;
  }

  /**
   * 生成统计数据的图片
   * @param {StatRecord[]} records - 统计记录数组
   * @param {keyof StatRecord} key - 统计键名
   * @param {string} title - 图表标题
   * @param {StatProcessOptions} options - 处理选项
   * @returns {Promise<Buffer>} 生成的图片Buffer
   */
  async generateStatImage(
    records: StatRecord[],
    key: keyof StatRecord,
    title: string,
    options: StatProcessOptions = {}
  ): Promise<Buffer> {
    // 转换记录为图表数据
    const chartData = this.recordsToChartData(records, key, {
      ...options,
      displayWhitelist: [],
      displayBlacklist: []
    });
    // 设置颜色主题
    const headerColor = key === 'userId' ? '#f56565' : (key === 'guildId' ? '#4fd1c5' : '#6366f1');
    // 当前时间
    const currentTime = Utils.formatDateTime(new Date());
    // 计算总次数和总项目数
    const totalItems = chartData.length;
    const totalCount = chartData.reduce((sum, item) => sum + item.value, 0);
    // 生成HTML内容并渲染
    const html = `
      <div style="padding:18px; box-shadow:0 2px 15px rgba(0,0,0,0.08); border-radius:12px; overflow:hidden; background-color:#fff;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; padding-bottom:10px; border-bottom:1px solid #eef0f5; flex-wrap:nowrap;">
          <div style="display:flex; gap:8px; flex-shrink:0; margin-right:12px;">
            <div style="background-color:#f8f9fa; border-radius:6px; padding:5px 10px; font-size:13px; white-space:nowrap; box-shadow:0 1px 3px rgba(0,0,0,0.04);">
              <span style="color:#666;">总项目: </span>
              <span style="font-weight:bold; color:#333;">${totalItems}</span>
            </div>
            <div style="background-color:#f8f9fa; border-radius:6px; padding:5px 10px; font-size:13px; white-space:nowrap; box-shadow:0 1px 3px rgba(0,0,0,0.04);">
              <span style="color:#666;">总${key === 'command' ? '次数' : '条数'}: </span>
              <span style="font-weight:bold; color:#333;">${totalCount}</span>
            </div>
          </div>
          <h2 style="margin:0; color:#333; font-size:19px; text-align:center; flex-grow:1; font-weight:600;">${title}</h2>
          <div style="font-size:12px; color:#888; background-color:#f8f9fa; padding:5px 10px; border-radius:6px; white-space:nowrap; flex-shrink:0; margin-left:12px; box-shadow:0 1px 3px rgba(0,0,0,0.04);">${currentTime}</div>
        </div>
        ${this.generateTableHTML(chartData, key, headerColor)}
      </div>
    `;
    return await this.htmlToImage(html);
  }

  /**
   * 生成综合统计图，将用户的所有统计信息整合到一张图中
   * @param {Array<{records: StatRecord[], title: string, key: keyof StatRecord, options?: StatProcessOptions}>} datasets - 多个数据集
   * @param {string} mainTitle - 主标题
   * @returns {Promise<Buffer>} 生成的图片Buffer
   */
  async generateCombinedStatImage(
    datasets: Array<{records: StatRecord[], title: string, key: keyof StatRecord, options?: StatProcessOptions}>,
    mainTitle: string
  ): Promise<Buffer> {
    // 处理数据集
    const tablesHTML = datasets.map(dataset => {
      if (!dataset.records.length) return '';
      const chartData = this.recordsToChartData(dataset.records, dataset.key, {
        ...dataset.options,
        displayWhitelist: [],
        displayBlacklist: []
      });

      const headerColor = dataset.key === 'command' ? '#6366f1' :
                         (dataset.key === 'guildId' ? '#4fd1c5' : '#f56565');
      // 计算总次数和总项目数
      const totalItems = chartData.length;
      const totalCount = chartData.reduce((sum, item) => sum + item.value, 0);

      return `
        <div style="margin-bottom:22px;">
          <div style="display:flex; align-items:center; margin:8px 0 12px 0; flex-wrap:nowrap;">
            <div style="display:flex; gap:8px; flex-shrink:0; margin-right:12px;">
              <div style="background-color:#f8f9fa; border-radius:6px; padding:4px 8px; font-size:12px; white-space:nowrap; box-shadow:0 1px 2px rgba(0,0,0,0.03);">
                <span style="color:#666;">总项目: </span>
                <span style="font-weight:bold; color:#333;">${totalItems}</span>
              </div>
              <div style="background-color:#f8f9fa; border-radius:6px; padding:4px 8px; font-size:12px; white-space:nowrap; box-shadow:0 1px 2px rgba(0,0,0,0.03);">
                <span style="color:#666;">${dataset.key === 'command' ? '次数' : '条数'}: </span>
                <span style="font-weight:bold; color:#333;">${totalCount}</span>
              </div>
            </div>
            <h3 style="margin:0; color:#333; font-size:17px; text-align:center; flex-grow:1; font-weight:600;">${dataset.title}</h3>
            <div style="flex-shrink:0; margin-left:10px; width:1px;"></div>
          </div>
          ${this.generateTableHTML(chartData, dataset.key, headerColor)}
        </div>
      `;
    }).join('');
    // 当前时间
    const currentTime = Utils.formatDateTime(new Date());
    // 组合所有内容
    const html = `
      <div style="padding:22px; box-shadow:0 3px 15px rgba(0,0,0,0.1); border-radius:14px; overflow:hidden; background-color:#fff;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:22px; padding-bottom:14px; border-bottom:1px solid #eef0f5; flex-wrap:nowrap;">
          <div style="min-width:10px; flex-shrink:0;"></div>
          <h2 style="margin:0; color:#333; font-size:20px; text-align:center; flex-grow:1; font-weight:600;">${mainTitle}</h2>
          <div style="font-size:12px; color:#888; background-color:#f8f9fa; padding:5px 10px; border-radius:6px; white-space:nowrap; flex-shrink:0; box-shadow:0 1px 3px rgba(0,0,0,0.05);">${currentTime}</div>
        </div>
        ${tablesHTML}
      </div>
    `;
    return await this.htmlToImage(html);
  }

  /**
   * 生成表格HTML (内部方法)
   * @param {Array<{name: string, value: number, time: string}>} data - 表格数据
   * @param {keyof StatRecord} key - 数据类型
   * @param {string} headerColor - 表头颜色
   * @returns {string} 表格HTML
   * @private
   */
  private generateTableHTML(data: Array<{name: string, value: number, time: string}>, key: keyof StatRecord, headerColor: string = '#6366f1'): string {
    // 计算总值用于百分比
    const totalValue = data.reduce((sum, item) => sum + item.value, 0);
    // 生成表格行HTML
    const generateRows = (items) => {
      return items.map((item, index) => {
        const valueText = key === 'command' ? `${item.value}次` : `${item.value}条`;
        const percentValue = (item.value / totalValue) * 100;
        const percentText = `${percentValue.toFixed(2)}%`;
        const bgColor = index % 2 === 0 ? '#ffffff' : '#fafbfd';

        return `
          <tr style="background-color:${bgColor};">
            <td style="padding:7px 10px; border-bottom:1px solid #eef0f5; font-weight:500;">${item.name}</td>
            <td style="padding:7px 10px; border-bottom:1px solid #eef0f5; text-align:right; white-space:nowrap; font-weight:500;">${valueText}</td>
            <td style="padding:7px 10px; border-bottom:1px solid #eef0f5; text-align:right; white-space:nowrap; font-family:monospace; color:#555;">${percentText}</td>
            <td style="padding:7px 10px; border-bottom:1px solid #eef0f5; text-align:right; white-space:nowrap; color:#666;">${item.time}</td>
          </tr>
        `;
      }).join('');
    };
    return `
      <div style="overflow:hidden; border-radius:10px; box-shadow:0 1px 8px rgba(0,0,0,0.08);">
        <table style="width:100%; border-collapse:separate; border-spacing:0; background:white;">
          <thead>
            <tr style="background:linear-gradient(to right, ${headerColor}, ${headerColor}cc);">
              <th style="padding:9px 12px; text-align:left; color:white; font-weight:600; border-radius:10px 0 0 0;">名称</th>
              <th style="padding:9px 12px; text-align:right; color:white; font-weight:600; white-space:nowrap;">数量</th>
              <th style="padding:9px 12px; text-align:right; color:white; font-weight:600; white-space:nowrap;">占比</th>
              <th style="padding:9px 12px; text-align:right; color:white; font-weight:600; white-space:nowrap; border-radius:0 10px 0 0;">最后统计</th>
            </tr>
          </thead>
          <tbody>
            ${generateRows(data)}
          </tbody>
        </table>
      </div>
    `;
  }
}
