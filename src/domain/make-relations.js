'use strict'

import domainEvents from './domain-events'
const {
  internalCacheRequest,
  internalCacheResponse,
  externalCacheRequest
} = domainEvents

const maxwait = process.env.REMOTE_OBJECT_MAXWAIT || 6000

export const relationType = {
  /**
   * Search memory and external storage
   * @param {import("./model").Model} model
   * @param {import("./datasource").default} ds
   * @param {import("./index").relations[relation]} rel
   * @returns {Promise<import('./index').datasource[]>}
   */
  oneToMany: async (model, ds, rel) => {
    // retrieve from memory
    const memory = ds.listSync({ [rel.foreignKey]: model.getId() })
    // call datasource interface to fetch from external storage
    const external = await ds.oneToMany(rel.foreignKey, model.getId())
    // return all
    return memory.concat(external)
  },

  /**
   * Search memory first, then external storage if not found.
   * @param {import(".").Model} model
   * @param {import("./datasource").default} ds
   * @param {import("./index").relations[relation]} config
   * @returns {Promise<import('./index').datasource>}
   */
  manyToOne: async (model, ds, rel) => {
    // search memory first
    const memory = ds.findSync(model[rel.foreignKey])
    // return if found
    if (memory) return memory
    // if not, call ds interface to search external storage
    return ds.manyToOne(model[rel.foreignKey])
  },

  /**
   *
   * @param {*} model
   * @param {*} ds
   * @param {*} rel
   * @returns
   */
  oneToOne (model, ds, rel) {
    return this.manyToOne(model, ds, rel)
  },

  containsMany: async (model, ds, rel) =>
    await Promise.all(
      model[rel.arrayKey].map(arrayItem => ds.find(arrayItem[rel.foreignKey]))
    ),

  custom: async (model, ds, rel) => ds[rel.name](model, ds, rel),

  findById: async (model, ds, rel) => ds.find(id)
}

const referentialIntegrity = {
  [relationType.manyToOne.name] (fromModel, toModels, relation, ds) {
    fromModel.updateSync({ [relation.foreignKey]: toModels[0].getId() }, false)
  },

  [relationType.oneToOne.name] (fromModel, toModels, relation, ds) {
    return this[relationType.manyToOne.name](fromModel, toModels, relation, ds)
  },

  [relationType.oneToMany.name] (fromModel, toModels, relation, ds) {
    toModels.map(m => {
      const model = ds.findSync(m.id)
      ds.saveSync({
        ...model,
        [relation.foreignKey]: fromModel.getId()
      })
    })
  },

  [relationType.containsMany.name] (fromModel, toModels, relation, ds) {}
}

/**
 * If we create a new object, foreign keys need to reference it
 * @param {import('./model').Model} fromModel
 * @param {import('./model').Model[]} toModels one or more models depending on the relation
 * @param {import('./index').relations[x]} relation
 * @param {import('./model-factory').Datasource} ds
 */
function updateForeignKeys (fromModel, toModels, relation, ds) {
  console.debug({ fn: updateForeignKeys.name, toModels })
  return referentialIntegrity[relation.type](fromModel, toModels, relation, ds)
}

/**
 *
 * @param {any[]} args - each arg is the input to a new model
 * @param {import('./model').Model} fromModel
 * @param {import('./index').relations[x]} relation
 * @param {import('./datasource').default} ds
 * @returns
 */
async function createNewModels (args, fromModel, relation, ds) {
  if (args.length > 0) {
    const { UseCaseService } = require('.')

    const service = UseCaseService(relation.modelName.toUpperCase())
    const newModels = await Promise.all(args.map(arg => service.addModel(arg)))
    return updateForeignKeys(fromModel, newModels, relation, ds)
  }
}

/**
 * Find existing, or create new, remote objects from
 * the distributed cache and store them in the local cache.
 *
 * Sends a request message to, and receives a response from,
 * the local cache manager.
 *
 * @param {import(".").relations[x]} relation
 * @param {import("./event-broker").EventBroker} broker
 * @returns {Promise<import(".").Event>} source model
 */
export function requireRemoteObject (model, relation, broker, ...args) {
  const request = internalCacheRequest(relation.modelName)
  const response = internalCacheResponse(relation.modelName)

  console.debug({ fn: requireRemoteObject.name })

  const name = (model ? model.getName() : relation.modelName).toUpperCase()
  const id = model ? model.getId() : relation.id
  const eventSource = name
  const eventTarget = model ? relation.modelName.toUpperCase() : null

  const requestData = {
    eventName: request,
    modelName: name,
    eventType: externalCacheRequest.name,
    eventSource,
    eventTarget,
    modelId: id,
    relation,
    model,
    args
  }

  return new Promise(async function (resolve) {
    setTimeout(resolve, maxwait)
    broker.on(response, resolve)
    broker.notify(request, requestData)
  })
}

function isRelatedModelLocal (relation) {
  return require('.')
    .default.getModelSpecs()
    .filter(spec => !spec.isCached)
    .map(spec => spec.modelName.toUpperCase())
    .includes(relation.modelName.toUpperCase())
}

/**
 * Generate functions to retrieve related domain objects.
 * @param {import("./index").relations} relations
 * @param {import("./datasource").default} datasource
 */
export default function makeRelations (relations, datasource, broker) {
  if (Object.getOwnPropertyNames(relations).length < 1) return

  return Object.keys(relations)
    .map(function (relation) {
      const rel = relations[relation]
      const modelName = rel.modelName.toUpperCase()
      rel.name = relation
      try {
        // relation type unknown
        if (!relationType[rel.type]) {
          console.warn('invalid relation', rel)
          return
        }

        return {
          // the relation function
          async [relation] (...args) {
            // Get or create datasource of related object
            const ds = datasource.getFactory().getDataSource(modelName)

            // args meancreate new local model instances
            if (args?.length > 0 && isRelatedModelLocal(rel)) {
              // args mean create new instance(s) of related model
              console.debug({ fn: relation, msg: 'creating new models' })
              return await createNewModels(args, this, rel, ds)
            }

            const models = await relationType[rel.type](this, ds, rel)

            if (!models || models.length < 1) {
              // couldn't find the object locally - try remote instances
              const event = await requireRemoteObject(
                this,
                rel,
                broker,
                ...args
              )

              // new models: update foreign keys
              if (event?.args?.length > 0)
                updateForeignKeys(this, event.model, rel, ds)

              return await relationType[rel.type](this, ds, rel)
            }

            return models
          }
        }
      } catch (e) {
        console.error(e)
      }
    })
    .reduce((c, p) => ({ ...p, ...c }))
}
