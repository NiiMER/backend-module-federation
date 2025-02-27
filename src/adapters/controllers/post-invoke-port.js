'use strict'

/**
 *
 * @param {import("../use-cases/add-model").invokePort} invokePort
 * @param {function():string} hash
 * @returns {import("./http-adapter").httpController}
 */
export default function anyInvokePortFactory (invokePort) {
  return async function anyInvokePort (httpRequest) {
    try {
      httpRequest.log(anyInvokePort.name)

      const result = await invokePort({
        port: httpRequest.params.port,
        args: httpRequest.body,
        id: httpRequest.params.id || null
      })

      console.debug({ function: invokePort.name, output: result })

      return {
        headers: {
          'Content-Type': 'application/json',
          'Last-Modified': new Date().toUTCString()
        },
        statusCode: 201,
        body: { ...result }
      }
    } catch (e) {
      console.error(e)

      return {
        headers: {
          'Content-Type': 'application/json'
        },
        statusCode: 400,
        body: {
          error: e.message
        }
      }
    }
  }
}
