import { Context } from 'koishi'
import {} from 'koishi-plugin-puppeteer'
import { StatProcessOptions } from './utils'
import { StatRecord } from './index'
import { utils } from './utils'

/**
 * 将HTML内容转换为图片
 * @param {string} html - 要渲染的HTML内容
 * @param {Context} ctx - Koishi上下文
 * @param {Object} options - 渲染选项
 * @param {number} [options.width] - 图片宽度
 * @returns {Promise<Buffer>} 图片Buffer数据
 */
export async function htmlToImage(html: string, ctx: Context, options: { width?: number } = {}): Promise<Buffer> {
  try {
    const page = await ctx.puppeteer.page()

    // 设置初始视口大小
    const viewportWidth = options.width || 1000
    await page.setViewport({
      width: viewportWidth,
      height: 1000,  // 初始高度，后面会根据内容调整
      deviceScaleFactor: 2.0
    })

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
            }
          </style>
        </head>
        <body>${html}</body>
      </html>
    `, { waitUntil: 'networkidle0' })

    // 计算实际内容高度
    const contentHeight = await page.evaluate(() => {
      return Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.offsetHeight
      ) + 40;  // 额外边距
    });

    // 调整视口高度
    await page.setViewport({
      width: viewportWidth,
      height: contentHeight,
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
      fullPage: true
    });

    await page.close();
    return imageBuffer;
  } catch (error) {
    ctx.logger.error('图片渲染出错:', error)
    throw new Error('生成图片时遇到问题，请稍后重试')
  }
}

/**
 * 将统计记录转换为图表数据
 * @param {StatRecord[]} records - 统计记录数组
 * @param {keyof StatRecord} key - 统计键名
 * @param {StatProcessOptions} options - 处理选项
 * @returns {Array<{name: string, value: number, time: string}>} 转换后的图表数据
 */
export function recordsToChartData(records: StatRecord[], key: keyof StatRecord, options: StatProcessOptions = {}): Array<{name: string, value: number, time: string}> {
  const {
    sortBy = 'count',
    disableCommandMerge = false,
    truncateId = false,
    displayBlacklist = [],
    displayWhitelist = []
  } = options;

  // 使用相同的StatMap逻辑处理数据聚合
  const keyFormatter = (key === 'command' && !disableCommandMerge)
    ? (k: string) => k?.split('.')[0] || '' : undefined;

  const dataMap = new Map<string, {count: number, lastTime: Date, displayName?: string}>();

  // 过滤记录
  const filteredRecords = (key === 'command' && !disableCommandMerge)
    ? records.filter(r => r.command !== '_message') : records;

  // 聚合记录
  for (const record of filteredRecords) {
    const recordKey = record[key] as string;

    // 优化过滤逻辑
    if (displayWhitelist.length && !displayWhitelist.some(p => recordKey.includes(p))) {
      continue;
    }
    if (displayBlacklist.length && displayBlacklist.some(p => recordKey.includes(p))) {
      continue;
    }

    const formattedKey = keyFormatter ? keyFormatter(recordKey) : recordKey;
    let displayName = formattedKey;

    if (key === 'userId' && record.userName) {
      displayName = truncateId ? record.userName : `${record.userName} (${recordKey})`;
    } else if (key === 'guildId' && record.guildName) {
      displayName = truncateId ? record.guildName : `${record.guildName} (${recordKey})`;
    }

    const current = dataMap.get(formattedKey) || { count: 0, lastTime: record.lastTime, displayName };
    current.count += record.count;
    if (record.lastTime > current.lastTime) {
      current.lastTime = record.lastTime;
    }
    dataMap.set(formattedKey, current);
  }

  // 转换为数组并排序
  let chartData = Array.from(dataMap.entries()).map(([key, data]) => ({
    name: data.displayName || key,
    value: data.count,
    time: utils.formatTimeAgo(data.lastTime)
  }));

  // 排序
  chartData.sort((a, b) => sortBy === 'count' ? b.value - a.value : a.name.localeCompare(b.name));

  return chartData;
}

/**
 * 生成统计数据的图片
 * @param {Context} ctx - Koishi上下文
 * @param {StatRecord[]} records - 统计记录数组
 * @param {keyof StatRecord} key - 统计键名
 * @param {string} title - 图表标题
 * @param {StatProcessOptions} options - 处理选项
 * @returns {Promise<Buffer>} 生成的图片Buffer
 */
export async function generateStatImage(
  ctx: Context,
  records: StatRecord[],
  key: keyof StatRecord,
  title: string,
  options: StatProcessOptions = {}
): Promise<Buffer> {
  // 转换记录为图表数据，确保不过滤小项
  const chartData = recordsToChartData(records, key, {
    ...options,
    // 确保显示所有数据，包括小项
    displayWhitelist: [],
    displayBlacklist: []
  });

  // 根据数据类型设置不同的颜色主题
  const headerColor = key === 'userId' ? '#ff6b81' : (key === 'guildId' ? '#5dd5a8' : '#4d7cfe');

  // 生成HTML内容并渲染
  const html = `
    <div style="padding:20px; max-width:940px; margin:0 auto; box-shadow:0 2px 10px rgba(0,0,0,0.1); border-radius:10px;">
      <h2 style="text-align:center; margin:0 0 20px; color:#333;">${title}</h2>
      ${generateTableHTML(chartData, key, headerColor)}
      <div style="text-align:center; margin-top:15px; font-size:13px; color:#888;">
        生成时间: ${new Date().toLocaleString()}
      </div>
    </div>
  `;

  // 渲染为图片
  return await htmlToImage(html, ctx, { width: 980 });
}

/**
 * 生成综合统计图，将用户的所有统计信息整合到一张图中
 * @param {Context} ctx - Koishi上下文
 * @param {Array<{records: StatRecord[], title: string, key: keyof StatRecord, options?: StatProcessOptions}>} datasets - 多个数据集
 * @param {string} mainTitle - 主标题
 * @param {Object} summaryData - 汇总数据
 * @returns {Promise<Buffer>} 生成的图片Buffer
 */
export async function generateCombinedStatImage(
  ctx: Context,
  datasets: Array<{records: StatRecord[], title: string, key: keyof StatRecord, options?: StatProcessOptions}>,
  mainTitle: string,
  summaryData: {label: string, value: string|number}[]
): Promise<Buffer> {
  // 处理数据集
  const tablesHTML = datasets.map(dataset => {
    if (!dataset.records.length) return '';

    // 使用完整数据集，不排除或合并小项
    const chartData = recordsToChartData(dataset.records, dataset.key, {
      ...dataset.options,
      // 保证不会过滤掉任何数据
      displayWhitelist: [],
      displayBlacklist: []
    });

    const headerColor = dataset.key === 'command' ? '#4d7cfe' :
                       (dataset.key === 'guildId' ? '#5dd5a8' : '#ff6b81');

    return `
      <div style="margin-bottom:25px;">
        <h3 style="margin:15px 0; color:#333;">${dataset.title}</h3>
        ${generateTableHTML(chartData, dataset.key, headerColor)}
      </div>
    `;
  }).join('');

  // 生成汇总卡片
  const summaryHTML = `
    <div style="text-align:center; margin-bottom:30px;">
      ${summaryData.map(item => `
        <div style="display:inline-block; background-color:#f8f9fa; border-radius:8px; padding:12px 20px; margin:8px; min-width:140px;">
          <div style="font-size:14px; color:#666; margin-bottom:5px;">${item.label}</div>
          <div style="font-size:20px; font-weight:bold; color:#333;">${item.value}</div>
        </div>
      `).join('')}
    </div>
  `;

  // 组合所有内容
  const html = `
    <div style="padding:25px; max-width:950px; margin:0 auto; box-shadow:0 2px 12px rgba(0,0,0,0.12); border-radius:10px;">
      <h2 style="text-align:center; margin:0 0 25px; padding-bottom:15px; border-bottom:1px solid #eee; color:#333;">
        ${mainTitle}
      </h2>
      ${summaryHTML}
      ${tablesHTML}
      <div style="text-align:center; margin-top:20px; padding-top:15px; border-top:1px solid #eee; font-size:13px; color:#888;">
        生成时间: ${new Date().toLocaleString()}
      </div>
    </div>
  `;

  // 渲染为图片
  return await htmlToImage(html, ctx, { width: 1000 });
}

/**
 * 生成表格HTML (内部函数)
 * @param {Array<{name: string, value: number, time: string}>} data - 表格数据
 * @param {keyof StatRecord} key - 数据类型
 * @param {string} headerColor - 表头颜色
 * @returns {string} 表格HTML
 */
function generateTableHTML(data: Array<{name: string, value: number, time: string}>, key: keyof StatRecord, headerColor: string = '#4d7cfe'): string {
  // 计算总值用于百分比
  const totalValue = data.reduce((sum, item) => sum + item.value, 0);

  // 生成表格行HTML - 不再分离小项，直接展示所有项目
  const generateRows = (items) => {
    return items.map(item => {
      const valueText = key === 'command' ? `${item.value}次` : `${item.value}条`;
      const percentValue = (item.value / totalValue) * 100;
      const percentText = percentValue < 1
        ? `${percentValue.toFixed(2)}%` // 小于1%的显示两位小数
        : `${percentValue.toFixed(1)}%`; // 其他显示一位小数

      // 对小于1%的项目应用略微不同的样式以提高辨识度
      const isSmallItem = percentValue < 1;
      const cellStyle = isSmallItem
        ? "padding:8px; border-bottom:1px solid #eee; color:#666;"
        : "padding:8px; border-bottom:1px solid #eee;";

      return `
        <tr>
          <td style="${cellStyle}">${item.name}</td>
          <td style="${cellStyle} text-align:right;">${valueText}</td>
          <td style="${cellStyle} text-align:right; width:70px;">${percentText}</td>
          <td style="${cellStyle} text-align:right; width:100px;">${item.time}</td>
        </tr>
      `;
    }).join('');
  };

  // 表格HTML
  return `
    <div style="overflow:hidden; border-radius:8px; box-shadow:0 1px 6px rgba(0,0,0,0.05);">
      <table style="width:100%; border-collapse:collapse; background:white;">
        <thead>
          <tr style="background-color:${headerColor}; color:white;">
            <th style="padding:10px; text-align:left;">名称</th>
            <th style="padding:10px; text-align:right;">数值</th>
            <th style="padding:10px; text-align:right; width:70px;">占比</th>
            <th style="padding:10px; text-align:right; width:100px;">最后活动</th>
          </tr>
        </thead>
        <tbody>
          ${generateRows(data)}
        </tbody>
        <tfoot>
          <tr style="background-color:#f9f9f9;">
            <td style="padding:8px; font-weight:bold;">总计</td>
            <td style="padding:8px; text-align:right; font-weight:bold;">
              ${totalValue}${key === 'command' ? '次' : '条'}
            </td>
            <td style="padding:8px; text-align:right; font-weight:bold;">100%</td>
            <td style="padding:8px; text-align:right;">${data.length}个项目</td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;
}
