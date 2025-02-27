'use strict'

import { performance as perf } from 'perf_hooks'
import loader from '@assemblyscript/loader'
import { EventBrokerFactory } from '../../domain'
import { WasmInterop } from './wasm-interop'
import { RepoClient } from './repo-client'
import { wasmAdapters } from '.'

const broker = EventBrokerFactory.getInstance()

/**
 * Import and run a WebAssembly module as an Aegis model, adapter, or service
 * @param {import('../../../webpack/remote-entries-type').remoteEntry} remoteEntry
 * @param {"model"|"service"|"adapter"} type
 * @returns
 */
export async function importWebAssembly (remoteEntry) {
  const startTime = perf.now()

  // Check if we support streaming instantiation y
  if (WebAssembly.instantiateStreaming) console.log('we can stream-compile now')

  const response = await RepoClient.fetch(remoteEntry)
  // compile and instantiate the wasm module, importing js funcs below
  const wasm = await loader.instantiate(response.asBase64Buffer(), {
    aegis: {
      log: ptr => console.log(wasm.exports.__getString(ptr)),

      /**
       * listen for event `eventName` and call a wasm exported
       * function by the name of `callbackName`.
       *
       * @param {string} eventName - name of event
       * @param {string} callbackName - name of exported function to run when event fires
       */
      addListener (eventName, callbackName) {
        const interop = WasmInterop(wasm)
        const event = wasm.exports.__getString(eventName)
        const callback = wasm.exports.__getString(callbackName)
        console.debug('addListener', callback, 'eventName', event)

        const fn = interop.findWasmFunction(callback)
        if (typeof fn !== 'function') {
          console.warn('callback is not a function', callback)
          return
        }

        broker.on(event, eventData => interop.callWasmFunction(fn, eventData), {
          once: true
        })
      },

      /**
       * Emit an event. Event listeners are invoked.
       * @param {string} eventName
       * @param {string} eventData
       */
      async fireEvent (eventName, eventData) {
        const interop = WasmInterop(wasm)
        const event = wasm.exports.__getString(eventName)
        const data = interop.constructObject(eventData)
        console.debug('fireEvent', data)
        broker.notify(event, data)
      },

      /**
       *
       * @param {string} remoteEntry - name of remote entry
       */
      requestDeployment: remoteEntry =>
        console.log('deploy', wasm.exports.__getString(remoteEntry))
    }
  })

  console.info('wasm modules took %dms', perf.now() - startTime)

  // delay immediate start to allow imports access to memory
  // compile with --explicitStart
  wasm.instance.exports._start()

  return wasmAdapters[remoteEntry.type](wasm)
}
