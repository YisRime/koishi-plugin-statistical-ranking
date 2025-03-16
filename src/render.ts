import { Context, h, Element } from 'koishi'
import {} from 'koishi-plugin-puppeteer'

export interface RendererConfig {
  enabled?: boolean
  theme?: 'light' | 'dark'
  width?: number
  showAvatar?: boolean
  timeout?: number
}

export class Renderer {
  private browser: any = null
  private pendingTasks = 0
  private ready = false

  static create(ctx: Context, config: RendererConfig = {}): Renderer {
    // 确保配置对象有默认值
    config = {
      enabled: false,
      theme: 'light',
      width: 800,
      showAvatar: true,
      timeout: 10,
      ...config
    }

    const renderer = new Renderer(ctx, config)

    // 仅当启用渲染时才初始化浏览器
    if (config.enabled) {
      renderer.init().catch(e => {
        ctx.logger.error('初始化渲染器失败:', e)
        renderer.ready = false
      })
    } else {
      ctx.logger.debug('图像渲染未启用')
    }

    return renderer
  }

  private constructor(private ctx: Context, private config: RendererConfig = {}) {
    // 确保配置对象完整
    this.config = {
      width: 800,
      timeout: 10,
      enabled: false,
      theme: 'light',
      showAvatar: true,
      ...config
    }
  }

  /**
   * 初始化渲染器
   */
  async init(): Promise<void> {
    if (!this.config.enabled) {
      this.ctx.logger.debug('图像渲染未启用')
      return
    }

    try {
      if (!this.ctx.puppeteer) {
        this.ctx.logger.warn('未找到puppeteer模块，图像渲染功能不可用')
        return
      }

      this.browser = this.ctx.puppeteer
      this.ready = true
      this.ctx.logger.info('图像渲染器初始化完成')
    } catch (error) {
      this.ctx.logger.error('渲染器初始化失败:', error)
      this.ready = false
    }
  }

  /**
   * 释放渲染器资源
   */
  async dispose(): Promise<void> {
    this.browser = null
    this.ready = false
  }

  /**
   * 生成统计数据图片
   */
  async renderStats(title: string, items: string[], options: {
    userName?: string,
    userAvatar?: string,
    showHeader?: boolean
  } = {}): Promise<Buffer | null> {
    if (!this.ready || !this.browser || this.pendingTasks > 5) {
      return null
    }

    this.pendingTasks++
    let page = null

    try {
      page = await this.browser.page()
      await page.setViewport({ width: this.config.width, height: 10 })
      // 准备HTML内容
      const html = this.generateHTML(title, items, options)
      await page.setContent(html)
      // 等待渲染完成
      await page.waitForSelector('.stat-container', { timeout: this.config.timeout * 1000 })
      // 获取内容高度并设置
      const height = await page.evaluate(() => {
        const body = document.querySelector('.stat-container')
        return body ? body.getBoundingClientRect().height : 500
      })

      await page.setViewport({ width: this.config.width, height: Math.ceil(height) + 20 })

      return await page.screenshot({ type: 'png' })
    } catch (error) {
      this.ctx.logger.error('渲染统计图片失败:', error)
      return null
    } finally {
      if (page) {
        await page.close().catch(e => this.ctx.logger.error('关闭页面失败:', e))
      }
      this.pendingTasks--
    }
  }

  /**
   * 生成统计图表的HTML内容
   */
  private generateHTML(title: string, items: string[], options: {
    userName?: string,
    userAvatar?: string,
    showHeader?: boolean
  } = {}): string {
    const isDark = this.config.theme === 'dark'
    const showAvatar = this.config.showAvatar !== false && options.userAvatar
    const showHeader = options.showHeader !== false
    // 提取标题和副标题
    let mainTitle = title
    let subTitle = ''

    const titleMatch = title.match(/(.*?)（(.*)）/)
    if (titleMatch) {
      mainTitle = titleMatch[1]
      subTitle = titleMatch[2]
    }

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body {
            margin: 0;
            padding: 0;
            font-family: 'Arial', 'Microsoft YaHei', sans-serif;
            background-color: ${isDark ? '#1e1e2e' : '#ffffff'};
            color: ${isDark ? '#cdd6f4' : '#333333'};
          }
          .stat-container {
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 4px 8px rgba(0, 0, 0, ${isDark ? '0.3' : '0.1'});
            background-color: ${isDark ? '#1e1e2e' : '#ffffff'};
          }
          .stat-header {
            display: flex;
            align-items: center;
            margin-bottom: 15px;
            border-bottom: 1px solid ${isDark ? '#313244' : '#eaeaea'};
            padding-bottom: 10px;
          }
          .avatar {
            width: 48px;
            height: 48px;
            border-radius: 50%;
            margin-right: 15px;
            border: 2px solid ${isDark ? '#89b4fa' : '#4285f4'};
            object-fit: cover;
          }
          .title-section { flex: 1; }
          .main-title {
            font-size: 18px;
            font-weight: bold;
            margin: 0;
            color: ${isDark ? '#cdd6f4' : '#333333'};
          }
          .sub-title {
            font-size: 14px;
            color: ${isDark ? '#9399b2' : '#666666'};
            margin: 5px 0 0 0;
          }
          .stat-items {
            font-family: 'Sarasa Mono SC', 'Cascadia Code', monospace;
            white-space: pre;
            line-height: 1.6;
            font-size: 14px;
            background-color: ${isDark ? '#11111b' : '#f8f9fa'};
            padding: 15px;
            border-radius: 6px;
          }
          .stat-item { margin-bottom: 5px; }
          .footer {
            margin-top: 15px;
            font-size: 12px;
            text-align: right;
            color: ${isDark ? '#9399b2' : '#888888'};
          }
        </style>
      </head>
      <body>
        <div class="stat-container">
          ${showHeader ? `
            <div class="stat-header">
              ${showAvatar ? `<img class="avatar" src="${options.userAvatar}" onerror="this.style.display='none'">` : ''}
              <div class="title-section">
                <h1 class="main-title">${mainTitle}</h1>
                ${subTitle ? `<p class="sub-title">${subTitle}</p>` : ''}
              </div>
            </div>
          ` : ''}
          <div class="stat-items">
            ${items.map(item => `<div class="stat-item">${item}</div>`).join('')}
          </div>
          <div class="footer">Generated by Koishi Statistical Ranking</div>
        </div>
      </body>
      </html>
    `
  }

  /**
   * 处理并渲染统计结果
   */
  async renderResult(title: string, items: string[], options: {
    userName?: string
    userAvatar?: string
    session?: any
    fallbackToText?: boolean
  } = {}): Promise<Element | string> {
    // 如果渲染器未就绪，直接返回文本
    if (!this.config.enabled || !this.ready || !this.browser) {
      return options.fallbackToText !== false ? `${title}\n${items.join('\n')}` : ''
    }

    try {
      // 尝试获取头像
      if (!options.userAvatar && options.session?.author?.avatar) {
        options.userAvatar = options.session.author.avatar
      }
      // 获取图片buffer
      const imageBuffer = await this.renderStats(title, items, {
        userName: options.userName,
        userAvatar: options.userAvatar
      })

      if (!imageBuffer) {
        return options.fallbackToText !== false ? `${title}\n${items.join('\n')}` : ''
      }
      // 创建图片元素
      return h.image(imageBuffer, 'image/png')
    } catch (error) {
      this.ctx.logger.error('渲染结果失败:', error)
      return options.fallbackToText !== false ? `${title}\n${items.join('\n')}` : ''
    }
  }
}
