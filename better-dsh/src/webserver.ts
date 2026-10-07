/** Native WebServer with the enabled welcome policy settled before its first listener. */
import { Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'

export default class BetterWebServer extends WebServer {
  static inject = ['loader']

  async [Service.init](): Promise<void> {
    const welcome = [...this.ctx.loader.entries()].find(entry => entry.options.id === 'dashr-welcome-notice')
    if (welcome !== undefined && !welcome.disabled) {
      if (welcome.fiber === undefined) await welcome.init()
      await welcome.fiber?.await()
    }
    this.ctx.fiber.assertActive()
    await super[Service.init]()
  }
}
