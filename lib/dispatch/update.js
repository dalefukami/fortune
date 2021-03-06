'use strict'

var deepEqual = require('deep-equal')
var assign = require('../common/assign')
var clone = require('../common/clone')
var validateRecords = require('./validate_records')
var checkLinks = require('./check_links')
var enforce = require('../record_type/enforce')
var message = require('../common/message')
var promise = require('../common/promise')
var applyUpdate = require('../common/apply_update')

var updateHelpers = require('./update_helpers')
var getUpdate = updateHelpers.getUpdate
var addId = updateHelpers.addId
var removeId = updateHelpers.removeId

var errors = require('../common/errors')
var NotFoundError = errors.NotFoundError
var BadRequestError = errors.BadRequestError

var find = require('../common/array/find')
var includes = require('../common/array/includes')
var map = require('../common/array/map')

var constants = require('../common/constants')
var changeEvent = constants.change
var updateMethod = constants.update
var primaryKey = constants.primary
var linkKey = constants.link
var inverseKey = constants.inverse
var isArrayKey = constants.isArray
var denormalizedInverseKey = constants.denormalizedInverse


/**
 * Do updates. First, it must find the records to update, then run transforms
 * and validation, then apply the update as well as links on related records.
 *
 * @return {Promise}
 */
module.exports = function (context) {
  var self = this
  var Promise = promise.Promise
  var adapter = self.adapter
  var serializer = self.serializer
  var recordTypes = self.recordTypes
  var transforms = self.transforms

  // Keyed by update, valued by record.
  var updateMap = new WeakMap()

  // Keyed by update, valued by hash of linked records.
  var linkedMap = new WeakMap()

  var relatedUpdates = {}
  var transformedUpdates = []

  var links = []
  var transaction, updates, fields, transform, type, meta, language

  return serializer.parseUpdate(context)

  .then(function (results) {
    var i, update, field

    updates = results
    validateUpdates(updates, context.request.meta)

    type = context.request.type
    meta = context.request.meta
    language = meta.language

    fields = recordTypes[type]
    transform = transforms[type]

    // Delete denormalized inverse fields, can't be updated.
    for (field in fields) {
      if (linkKey in fields[field]) links.push(field)
      if (denormalizedInverseKey in fields[field])
        for (i = updates.length; i--;) {
          update = updates[i]
          if (update.replace) delete update.replace[field]
          if (update.push) delete update.push[field]
          if (update.pull) delete update.pull[field]
        }
    }

    return adapter.beginTransaction()
  })

  .then(function (result) {
    context.transaction = transaction = result

    return adapter.find(type, map(updates, function (update) {
      return update[primaryKey]
    }), null, meta)
  })

  .then(function (records) {
    return Promise.all(map(records, function (record) {
      var update, cloneUpdate
      var hasTransform = transform && transform.input
      var id = record[primaryKey]

      update = find(updates, function (update) {
        return update[primaryKey] === id
      })

      if (!update) throw new NotFoundError(
        message('UpdateRecordMissing', language))

      if (hasTransform) cloneUpdate = clone(update)

      return Promise.resolve(hasTransform ?
        transform.input(context, record, update) : update)
      .then(function (update) {
        if (hasTransform) {
          // Check if the update has been modified or not.
          if (!deepEqual(update, cloneUpdate, { strict: true }))
            Object.defineProperty(context.response,
              'updateModified', { value: true })

          // Runtime safety check: primary key must be the same.
          if (update[primaryKey] !== id) throw new BadRequestError(
            message('InvalidID', language))
        }

        transformedUpdates.push(update)
        updateMap.set(update, record)

        // Shallow clone the record.
        record = assign({}, record)

        // Apply updates to record.
        applyUpdate(record, update)

        // Apply operators to record.
        if (update.operate)
          record = adapter.applyOperators(record, update.operate)

        // Enforce the fields.
        enforce(type, record, fields, meta)

        // Ensure referential integrity.
        return checkLinks.call(self, record, fields, links, meta)
        .then(function (linked) {
          linkedMap.set(update, linked)
          return record
        })
      })
    }))
  })

  .then(function (records) {
    var i

    validateRecords.call(self, records, fields, links, meta)

    Object.defineProperty(context.response, 'records', {
      configurable: true,
      value: records
    })

    // Drop fields in the updates that aren't defined in the record type
    // before doing the update.
    for (i = transformedUpdates.length; i--;)
      dropFields(transformedUpdates[i], fields)

    return transaction.update(type, transformedUpdates, meta)
  })

  .then(function () {
    var inverseField
    var isArray
    var linkedType
    var linkedIsArray
    var linked
    var record
    var partialRecord, partialRecords
    var ids, id
    var push, pull
    var update
    var field
    var i, j, k, l

    // Build up related updates based on update objects.
    var idCache = {}

    // Iterate over each update to generate related updates.
    for (i = transformedUpdates.length; i--;) {
      update = transformedUpdates[i]

      for (j = links.length; j--;) {
        field = links[j]
        inverseField = fields[field][inverseKey]

        if (!inverseField) continue

        isArray = fields[field][isArrayKey]
        linkedType = fields[field][linkKey]
        linkedIsArray =
          recordTypes[linkedType][inverseField][isArrayKey]

        // Do some initialization.
        if (!relatedUpdates[linkedType]) relatedUpdates[linkedType] = []
        if (!idCache[linkedType]) idCache[linkedType] = {}

        record = updateMap.get(update)
        linked = linkedMap.get(update)

        // Replacing a link field is pretty complicated.
        if (update.replace && field in update.replace) {
          id = update.replace[field]

          if (!Array.isArray(id)) {
            // Set related field.
            if (id !== null)
              addId(update[primaryKey],
                getUpdate(linkedType, id, relatedUpdates, idCache),
                inverseField, linkedIsArray)

            // Unset 2nd degree related record.
            if (field in linked &&
              linked[field][inverseField] !== null &&
              !linkedIsArray &&
              linked[field][inverseField] !== update[primaryKey])
              removeId(id,
                getUpdate(
                  linkedType, linked[field][inverseField],
                  relatedUpdates, idCache),
                inverseField, linkedIsArray)

            // For unsetting, remove ID from related record.
            if (record[field] !== null &&
              record[field] !== update[field] &&
              record[field] !== id)
              removeId(update[primaryKey],
                getUpdate(
                  linkedType, record[field], relatedUpdates, idCache),
                inverseField, linkedIsArray)

            // After this point, there's no need to go over push/pull.
            continue
          }

          ids = id

          // Compute differences for push, and mutate the update.
          for (k = 0, l = ids.length; k < l; k++) {
            id = ids[k]
            if (!includes(record[field], id)) {
              if (!('push' in update)) update.push = {}
              if (field in update.push) {
                if (Array.isArray(update.push[field])) {
                  update.push[field].push(id)
                  continue
                }
                update.push[field] = [ update.push[field], id ]
                continue
              }
              update.push[field] = [ id ]
            }
          }

          // Compute differences for pull, and mutate the update.
          for (k = 0, l = record[field].length; k < l; k++) {
            id = record[field][k]
            if (!includes(ids, id)) {
              if (!('pull' in update)) update.pull = {}
              if (field in update.pull) {
                if (Array.isArray(update.pull[field])) {
                  update.pull[field].push(id)
                  continue
                }
                update.pull[field] = [ update.pull[field], id ]
                continue
              }
              update.pull[field] = [ id ]
            }
          }

          // Delete the original replace, since it is no longer valid.
          delete update.replace[field]
        }

        if (update.push && update.push[field]) {
          push = Array.isArray(update.push[field]) ?
            update.push[field] : [ update.push[field] ]

          for (k = 0, l = push.length; k < l; k++) {
            id = push[k]
            if (id !== null)
              addId(update[primaryKey],
                getUpdate(linkedType, id, relatedUpdates, idCache),
                inverseField, linkedIsArray)
          }
        }

        if (update.pull && update.pull[field]) {
          pull = Array.isArray(update.pull[field]) ?
            update.pull[field] : [ update.pull[field] ]

          for (k = 0, l = pull.length; k < l; k++) {
            id = pull[k]
            if (id !== null)
              removeId(update[primaryKey],
                getUpdate(linkedType, id, relatedUpdates, idCache),
                inverseField, linkedIsArray)
          }
        }

        // Unset from 2nd degree related records.
        if (field in linked && !linkedIsArray) {
          partialRecords = Array.isArray(linked[field]) ?
            linked[field] : [ linked[field] ]

          for (k = 0, l = partialRecords.length; k < l; k++) {
            partialRecord = partialRecords[k]

            if (partialRecord[inverseField] === update[primaryKey])
              continue

            removeId(partialRecord[primaryKey],
              getUpdate(
                type, partialRecord[inverseField],
                relatedUpdates, idCache),
              field, isArray)
          }
        }
      }
    }

    return Promise.all(map(Object.keys(relatedUpdates), function (type) {
      return relatedUpdates[type].length ?
        transaction.update(type, relatedUpdates[type], meta) :
        null
    }))
  })

  .then(function () {
    return transaction.endTransaction()
  })

  // This makes sure to call `endTransaction` before re-throwing the error.
  .catch(function (error) {
    if (transaction) transaction.endTransaction(error)
    throw error
  })

  .then(function () {
    var eventData = {}, linkedType

    eventData[updateMethod] = {}
    eventData[updateMethod][type] = transformedUpdates

    for (linkedType in relatedUpdates) {
      if (!relatedUpdates[linkedType].length) continue

      if (linkedType !== type)
        eventData[updateMethod][linkedType] = relatedUpdates[linkedType]

      // Get the union of update IDs.
      else eventData[updateMethod][type] =
        eventData[updateMethod][type].concat(relatedUpdates[type])
    }

    // Summarize changes during the lifecycle of the request.
    self.emit(changeEvent, eventData)

    return context
  })
}


// Validate updates.
function validateUpdates (updates, meta) {
  var language = meta.language
  var i, update

  if (!updates || !updates.length)
    throw new BadRequestError(
      message('UpdateRecordsInvalid', language))

  for (i = updates.length; i--;) {
    update = updates[i]
    if (!update[primaryKey])
      throw new BadRequestError(
        message('UpdateRecordMissingID', language))
  }
}


function dropFields (update, fields) {
  var field

  for (field in update.replace)
    if (!(field in fields)) delete update.replace[field]

  for (field in update.push)
    if (!(field in fields)) delete update.push[field]

  for (field in update.pull)
    if (!(field in fields)) delete update.pull[field]
}
