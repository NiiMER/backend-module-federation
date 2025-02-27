'use strict'

/**
 *
 * @param {import("../use-cases/add-model").addModel} addModel
 * @param {function():string} hash
 * @returns {import("./http-adapter").httpController}
 */
export default function postModelFactory (addModel) {
  return async function postModel (httpRequest) {
    try {
      httpRequest.log(postModel.name)

      const model = await addModel(httpRequest.body)

      console.debug({ function: addModel.name, output: model })

      return {
        headers: {
          'Content-Type': 'application/json',
          'Last-Modified': new Date().toUTCString()
        },
        statusCode: 201,
        body: { modelId: model.id }
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
