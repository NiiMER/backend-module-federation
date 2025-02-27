/**
 * webswitch (c)
 *
 * Websocket clients connect to a common ws server,
 * called a webswitch. When a client sends a message,
 * webswitch broadcasts the message to all other
 * connected clients, including a special webswitch
 * server that acts as an uplink to another network,
 * if one is defined. A Webswitch server can also
 * receive messgages from an uplink and will broadcast
 * those messages to its clients as well.
 */

'use strict'

import os from 'os'
import WebSocket from 'ws'
import EventEmitter from 'events'
import CircuitBreaker from '../../domain/circuit-breaker.js'
import { ServiceLocator } from './service-locator.js'
import { readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { stat } from 'fs'

const HOSTNAME = 'webswitch.local'
const SERVICENAME = 'webswitch'
const TIMEOUTEVENT = 'webswitchTimeout'
const CONNECTERROR = 'webswitchConnect'
const WSOCKETERROR = 'webswitchWsocket'

const configRoot = require('../../config').hostConfig
const config = configRoot.services.serviceMesh.WebSwitch
const isPrimary =
  /true/i.test(process.env.SWITCH) ||
  (typeof process.env.SWITCH === 'undefined' && config.isSwitch)

const debug = config.debug || /true/i.test(process.env.DEBUG)
const heartbeatms = config.heartbeat || 10000
const sslEnabled = /true/i.test(process.env.SSL_ENABLED)
const clearPort = process.env.PORT || 80
const cipherPort = process.env.SSL_PORT || 443
const activePort = sslEnabled ? cipherPort : clearPort
const activeProto = sslEnabled ? 'wss' : 'ws'
const activeHost =
  process.env.DOMAIN ||
  configRoot.services.cert.domain ||
  configRoot.general.fqdn

const protocol = isPrimary ? activeProto : config.protocol
const port = isPrimary ? activePort : config.port
const host = isPrimary ? activeHost : config.host
const isBackup = config.isBackupSwitch

const constructUrl = () =>
  protocol && host && port ? `${protocol}://${host}:${port}` : null

let uplinkCallback

export class ServiceMeshClient extends EventEmitter {
  constructor (url = null) {
    super()
    this.ws = null
    this.url = url || constructUrl()
    this.name = SERVICENAME
    this.serviceList = []
    this.isPrimary = isPrimary
    this.isBackup = isBackup
    this.pong = true
    this.timerId = 0
    this.reconnecting = false
    this.sendQueue = []
    this.sendQueueLimit = 20
    this.headers = {
      'x-webswitch-host': os.hostname(),
      'x-webswitch-role': 'node',
      'x-webswitch-pid': process.pid
    }
  }

  services () {
    return this.options.listServices
      ? (this.serviceList = this.options.listServices())
      : this.serviceList
  }

  telemetry () {
    return {
      eventName: 'telemetry',
      proto: this.name,
      hostname: os.hostname(),
      role: 'node',
      pid: process.pid,
      telemetry: { ...process.memoryUsage(), ...process.cpuUsage() },
      services: this.services(),
      state: this.ws?.readyState || 'undefined'
    }
  }

  async resolveUrl () {
    const locator = new ServiceLocator({
      name: this.name,
      serviceUrl: constructUrl(),
      primary: this.isPrimary,
      backup: this.isBackup
    })
    if (this.isPrimary) {
      locator.answer()
      return constructUrl()
    }
    return locator.listen()
  }

  async connect (options = {}) {
    if (this.ws) {
      console.info('conn already open')
      return
    }
    this.options = options
    this.url = await this.resolveUrl()
    this.ws = new WebSocket(this.url, {
      headers: this.headers,
      protocol: SERVICENAME
    })

    this.ws.binaryType = 'arraybuffer'

    this.ws.on('close', (code, reason) => {
      console.log('received close frame', code, reason.toString())
      this.emit(CONNECTERROR, reason)
      if ([1006, 4040].includes(code)) {
        if (this.reconnecting) return
        this.reconnecting = true
        clearTimeout(this.timerId)
        this.close(code, reason)
        setTimeout(() => this.connect(), 8000)
      }
    })

    this.ws.on('open', () => {
      console.log('connection open')
      this.reconnecting = false
      this.send(this.telemetry())
      this.heartbeat()
      setTimeout(() => this.sendQueuedMsgs(), 1000)
    })

    this.ws.on('message', message => {
      try {
        const event = this.decode(message)
        if (!event.eventName) {
          debug && console.debug({ missingEventName: event })
          this.emit('missingEventName', event)
          return
        }
        this.emit(event.eventName, event)
        this.listeners('*').forEach(listener => listener(event))
      } catch (error) {
        console.error({ fn: this.connect.name, error })
      }
    })

    this.ws.on('error', error => {
      this.emit(WSOCKETERROR, error)
      console.error({ fn: this.connect.name, error })
    })

    this.ws.on('pong', () => (this.pong = true))
  }

  heartbeat () {
    if (this.pong) {
      this.pong = false
      this.ws.ping()
      this.timerId = setTimeout(() => this.heartbeat(), heartbeatms)
    } else {
      if (this.reconnecting) return
      this.reconnecting = true
      console.warn('timeout')
      this.close(4877, 'timeout')
      setTimeout(() => this.connect(), 5000)
      this.emit(TIMEOUTEVENT, this.telemetry())
    }
  }

  sendQueuedMsgs () {
    try {
      while (this.sendQueue.length > 0) this.send(this.sendQueue.pop())
    } catch (error) {
      console.error({ fn: this.sendQueuedMsgs.name, error })
    }
  }

  primitives = {
    encode: {
      object: msg => Buffer.from(JSON.stringify(msg)),
      string: msg => Buffer.from(JSON.stringify(msg)),
      number: msg => Buffer.from(JSON.stringify(msg)),
      symbol: msg => console.log('unsupported', msg),
      undefined: msg => console.log('undefined', msg)
    },
    decode: {
      object: msg => JSON.parse(Buffer.from(msg).toString()),
      string: msg => msg,
      number: msg => msg,
      symbol: msg => msg,
      undefined: msg => console.error('undefined', msg)
    }
  }

  encode (msg) {
    const encoded = this.primitives.encode[typeof msg](msg)
    debug && console.debug({ encoded })
    return encoded
  }

  decode (msg) {
    const decoded = this.primitives.decode[typeof msg](msg)
    debug && console.debug({ decoded })
    return decoded
  }

  send (msg) {
    if (
      this.ws &&
      this.ws.readyState === this.ws.OPEN &&
      this.ws.bufferedAmount < 1
    ) {
      const breaker = CircuitBreaker('webswitch', msg => {
        debug && console.debug({ fn: this.send.name, msg })
        this.ws.send(this.encode(msg))
      })
      breaker.detectErrors([TIMEOUTEVENT, CONNECTERROR, WSOCKETERROR], this)
      breaker.invoke(msg)
      return true
    } else if (this.sendQueue.length < this.sendQueueLimit) {
      this.sendQueue.push(msg)
    } else {
      this.manageSendQueue(msg)
    }
    return false
  }

  manageSendQueue (msg) {
    this.sendQueue.push(msg)
    this.saveSendQueue(queue => {
      return new Promise(resolve => {
        this.sendQueuedMsgs(queue)
        resolve(queue)
      })
    })
  }

  async saveSendQueue (sender) {
    try {
      if (this.sendQueue.length < 1.5 * this.sendQueueLimit) {
        await sender(this.sendQueue)
        return
      }
      const file = path.join(process.cwd(), 'public', 'senderQueue.json')
      const size = await new Promise(resolve =>
        stat(file, (err, stats) => resolve(stats.size))
      )
      if (size > 99999999) {
        console.log('queue backing store too large')
        return
      }
      const storedQueue = JSON.parse(
        Buffer.from(readFileSync(file, 'binary')).toString()
      )
      const concatQueue = storedQueue.concat(this.sendQueue)
      const unsentQueue = await sender(concatQueue)
      writeFileSync(file, Buffer.from(JSON.stringify(unsentQueue)), 'binary')
    } catch (error) {
      console.error({ fn: this.saveSendQueue.name, error })
    }
  }

  async publish (msg) {
    debug && console.debug({ fn: this.publish.name, msg })
    await this.connect()
    this.send(msg)
  }

  subscribe (eventName, callback) {
    this.on(eventName, callback)
  }

  close (code, reason) {
    console.debug('closing socket')
    this.ws.removeAllListeners()
    this.ws.close(code, reason)
    this.ws.terminate()
    this.ws = null
  }
}
