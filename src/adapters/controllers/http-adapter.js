'use strict'
/**
 * @callback httpController
 * @param {{
 *  body:{key1,keyN},
 *  query:{key1},
 *  params:{key1,keyN},
 *  log:(functionName)=>void
 * }} httpRequest
 * @returns {{
 *  body:{key1,keyN},
 *  headers:{key1,keyN}
 * }}
 */

/**
 * @param {httpController} controller
 */
export default function buildCallback(controller) {
  /**
   * @param {import("nats/lib/nats-base-client/types").StreamInfoRequestOptions}
   */
  return async (req, res) => {
    const httpRequest = {
      body: req.body,
      query: req.query,
      params: req.params,
      ip: req.ip,
      method: req.method,
      path: req.path,
      res: res,
      log(func) {
        console.info({
          function: func,
          ip: httpRequest.ip,
          method: httpRequest.method,
          params: httpRequest.params,
          query: httpRequest.query,
          body: httpRequest.body
        })
      }
    }

    return controller(httpRequest)
      .then(httpResponse => {
        if (httpRequest.stream) return
        if (httpResponse.headers) {
          res.set(httpResponse.headers)
        }
        res.status(httpResponse.statusCode).send(httpResponse.body)
        return httpResponse
      })
      .catch(e => res.status(500).send({ error: 'An unkown error occurred.', e }))
  }
}
