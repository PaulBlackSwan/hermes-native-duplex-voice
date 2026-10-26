import { GrokLiveSession } from './grok'

export default {
  id: 'grok-native-provider',
  name: 'Grok Native Voice Provider',
  defaultEnabled: false,
  register(ctx: { registerLiveVoiceProvider?: (provider: unknown) => unknown }) {
    if (typeof ctx.registerLiveVoiceProvider !== 'function') {
      throw new Error('Grok Native Voice requires registerLiveVoiceProvider (native live voice API v1).')
    }
    ctx.registerLiveVoiceProvider({
      apiVersion: 1,
      id: 'xai-oauth',
      createSession(bridge: ConstructorParameters<typeof GrokLiveSession>[0], handlers: ConstructorParameters<typeof GrokLiveSession>[1]) {
        return new GrokLiveSession(bridge, handlers)
      }
    })
  }
}
